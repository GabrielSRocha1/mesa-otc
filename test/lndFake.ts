/**
 * LndFake — nó LND REST em memória para testes (modelo test/esploraRegtest.ts). Fala o subconjunto
 * REST que o LndRestService consome, para exercitar o cliente HTTP REAL contra ele (nada é stubbado
 * no nível do cliente). O "pagamento" casa sha256(preimage)==payment_hash — a MESMA verificação do
 * contrato — e revela a preimage. A preimage é semeada por fora (ela é do Comprador, como na rede).
 */
import { createServer, type Server } from 'node:http';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const b64ToHex = (b64: string): string => Buffer.from(b64, 'base64').toString('hex');
const hexToB64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

export class LndFake {
  private server!: Server;
  url = '';
  outboundSat = 100_000_000n;
  private readonly invoices = new Map<string, { bolt11: string; paymentHash: string; amountSat: bigint }>(); // hash→invoice
  private readonly preimages = new Map<string, string>();  // hash→preimage (do Comprador)
  private readonly settled = new Map<string, string>();     // hash→preimage revelada no pagamento

  /** Semeia a preimage que o recebedor (Comprador) revelará ao ser pago. */
  seedPreimage(preimageHex: string): string { const h = bytesToHex(sha256(hexToBytes(preimageHex))); this.preimages.set(h, preimageHex.toLowerCase()); return h; }
  setOutbound(sat: bigint): void { this.outboundSat = sat; }

  private respond(method: string, path: string, body: string | null): { code: number; body: unknown } {
    if (method === 'GET' && path === '/v1/getinfo') return { code: 200, body: { identity_pubkey: '02'.padEnd(66, '0'), alias: 'lnd-fake', chains: [{ chain: 'bitcoin' }] } };
    if (method === 'GET' && path === '/v1/balance/channels') return { code: 200, body: { local_balance: { sat: this.outboundSat.toString() }, remote_balance: { sat: '0' } } };
    if (method === 'POST' && path === '/v2/invoices/hodl') {
      const b = JSON.parse(body ?? '{}') as { hash: string; value: string };
      const hash = b64ToHex(b.hash); const amountSat = BigInt(b.value ?? '0');
      const bolt11 = `lnbcrt${amountSat}sim${hash.slice(0, 20)}`;
      this.invoices.set(hash, { bolt11, paymentHash: hash, amountSat });
      return { code: 200, body: { payment_request: bolt11 } };
    }
    let m = /^\/v1\/payreq\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      const inv = [...this.invoices.values()].find(i => i.bolt11 === decodeURIComponent(m![1] as string));
      if (!inv) return { code: 404, body: { error: 'invoice desconhecida' } };
      return { code: 200, body: { payment_hash: inv.paymentHash, num_satoshis: inv.amountSat.toString(), expiry: '600', timestamp: String(Math.floor(Date.now() / 1000)) } };
    }
    if (method === 'POST' && path === '/v2/router/send') {
      const b = JSON.parse(body ?? '{}') as { payment_request: string };
      const inv = [...this.invoices.values()].find(i => i.bolt11 === b.payment_request);
      if (!inv) return { code: 200, body: { result: { status: 'FAILED', failure_reason: 'FAILURE_REASON_NO_ROUTE' } } };
      if (inv.amountSat > this.outboundSat) return { code: 200, body: { result: { status: 'FAILED', payment_hash: hexToB64(inv.paymentHash), failure_reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE' } } };
      const preimage = this.preimages.get(inv.paymentHash);
      if (!preimage) return { code: 200, body: { result: { status: 'FAILED', payment_hash: hexToB64(inv.paymentHash), failure_reason: 'FAILURE_REASON_TIMEOUT' } } };
      this.outboundSat -= inv.amountSat; this.settled.set(inv.paymentHash, preimage);
      return { code: 200, body: { result: { status: 'SUCCEEDED', payment_hash: hexToB64(inv.paymentHash), payment_preimage: hexToB64(preimage) } } };
    }
    m = /^\/v2\/router\/track\/([0-9a-fA-F]+)$/.exec(path);
    if (method === 'GET' && m) {
      const hash = (m[1] as string).toLowerCase(); const pre = this.settled.get(hash);
      if (pre) return { code: 200, body: { status: 'SUCCEEDED', payment_preimage: hexToB64(pre) } };
      return { code: 200, body: { status: 'IN_FLIGHT' } };
    }
    return { code: 404, body: { error: 'not found' } };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        const r = this.respond(req.method ?? 'GET', (req.url ?? '').split('?')[0] ?? '', req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : null);
        res.writeHead(r.code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>(ok => this.server.listen(0, '127.0.0.1', ok));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }
  async stop(): Promise<void> { await new Promise<void>(ok => this.server.close(() => ok())); }
}
