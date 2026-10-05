/**
 * Esplora REGTEST in-process — servidor HTTP que implementa o subconjunto da API Esplora usado
 * pelo BitcoinChainAdapter (blockstream/mempool compatível) sobre uma chain em memória.
 * Transações chegam por POST /tx como HEX REAL (segwit v2), são parseadas byte a byte, têm o
 * txid recomputado (dsha256 sem witness) e movem o conjunto de UTXOs como um nó regtest faria.
 * Sem bitcoind/docker na máquina: é o "regtest" do E2E — o adapter fala HTTP de verdade.
 */
import { createServer, type Server } from 'node:http';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';

const dsha256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));

interface Utxo { txid: string; vout: number; value: number; address: string; height: number }
export interface RegtestTx { txid: string; height: number; vin: { txid: string; vout: number; witness: string[] }[]; vout: { scriptpubkey_address: string | null; value: number }[] }

/** Leitor binário mínimo para o parse de transações segwit. */
class Reader {
  i = 0;
  constructor(private readonly b: Uint8Array) {}
  take(n: number): Uint8Array { const out = this.b.slice(this.i, this.i + n); this.i += n; return out; }
  u32(): number { const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 4).getUint32(0, true); this.i += 4; return v; }
  u64(): bigint { const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 8).getBigUint64(0, true); this.i += 8; return v; }
  varint(): number {
    const f = this.take(1)[0] as number;
    if (f < 0xfd) return f;
    if (f === 0xfd) { const b = this.take(2); return (b[0] as number) | ((b[1] as number) << 8); }
    return this.u32();
  }
  peekByte(off = 0): number { return this.b[this.i + off] as number; }
}

function addressOfScript(script: Uint8Array): string | null {
  const hex = bytesToHex(script);
  if (hex.startsWith('0014') && script.length === 22) return bech32.encode('bcrt', [0, ...bech32.toWords(script.slice(2))], 90);
  if (hex.startsWith('0020') && script.length === 34) return bech32.encode('bcrt', [0, ...bech32.toWords(script.slice(2))], 120);
  return null;
}

/** Parse de uma transação (legacy ou segwit) + txid (dsha256 da serialização SEM witness). */
export function parseTx(hex: string): RegtestTx & { coreHex: string } {
  const raw = hexToBytes(hex);
  const r = new Reader(raw);
  const version = r.take(4);
  const segwit = r.peekByte() === 0x00 && r.peekByte(1) === 0x01;
  if (segwit) r.take(2);
  const coreStart = r.i;
  const nIn = r.varint();
  const vin: RegtestTx['vin'][number][] = [];
  for (let k = 0; k < nIn; k++) {
    const txid = bytesToHex(r.take(32).reverse());
    const vout = r.u32();
    const sl = r.varint(); r.take(sl);
    r.u32(); // sequence
    vin.push({ txid, vout, witness: [] });
  }
  const nOut = r.varint();
  const vout: RegtestTx['vout'][number][] = [];
  for (let k = 0; k < nOut; k++) {
    const value = Number(r.u64());
    const sl = r.varint();
    vout.push({ scriptpubkey_address: addressOfScript(r.take(sl)), value });
  }
  const coreEnd = r.i;
  if (segwit) for (const v of vin) { const n = r.varint(); for (let k = 0; k < n; k++) { const l = r.varint(); v.witness.push(bytesToHex(r.take(l))); } }
  const locktime = r.take(4);
  const noWitness = concatBytes(version, raw.slice(coreStart, coreEnd), locktime);
  return { txid: bytesToHex(dsha256(noWitness).reverse()), height: 0, vin, vout, coreHex: bytesToHex(noWitness) };
}

export class EsploraRegtest {
  height = 200;
  private readonly utxos = new Map<string, Utxo>();   // txid:vout → utxo vivo
  private readonly fundedByAddr = new Map<string, number>(); // somatório histórico p/ chain_stats
  readonly txs: RegtestTx[] = [];
  private server!: Server;
  url = '';

  /** Faucet regtest: credita um UTXO maduro (como um coinbase + 150 blocos). */
  faucet(address: string, sats: number): { txid: string; vout: number; value: number } {
    const txid = bytesToHex(sha256(utf8ToBytes(`faucet:${this.txs.length}:${address}`)));
    const tx: RegtestTx = { txid, height: this.height - 150, vin: [], vout: [{ scriptpubkey_address: address, value: sats }] };
    this.txs.push(tx);
    this.utxos.set(`${txid}:0`, { txid, vout: 0, value: sats, address, height: tx.height });
    this.fundedByAddr.set(address, (this.fundedByAddr.get(address) ?? 0) + sats);
    return { txid, vout: 0, value: sats };
  }
  mine(n = 1): void { this.height += n; }
  utxosOf(address: string): Utxo[] { return [...this.utxos.values()].filter(u => u.address === address); }

  /** Valida inputs contra o UTXO set, aplica e "minera" imediatamente (1 confirmação). */
  private broadcast(hex: string): string {
    const tx = parseTx(hex);
    for (const v of tx.vin) {
      if (!this.utxos.has(`${v.txid}:${v.vout}`)) throw new Error(`bad-txns-inputs-missingorspent ${v.txid}:${v.vout}`);
    }
    for (const v of tx.vin) this.utxos.delete(`${v.txid}:${v.vout}`);
    tx.height = ++this.height;
    tx.vout.forEach((o, i) => {
      if (!o.scriptpubkey_address) return;
      this.utxos.set(`${tx.txid}:${i}`, { txid: tx.txid, vout: i, value: o.value, address: o.scriptpubkey_address, height: tx.height });
      this.fundedByAddr.set(o.scriptpubkey_address, (this.fundedByAddr.get(o.scriptpubkey_address) ?? 0) + o.value);
    });
    this.txs.push(tx);
    return tx.txid;
  }

  private respond(path: string, body: string | null): { code: number; body: string; type: string } {
    const json = (o: unknown) => ({ code: 200, body: JSON.stringify(o), type: 'application/json' });
    const text = (s: string | number) => ({ code: 200, body: String(s), type: 'text/plain' });
    if (path === '/blocks/tip/height') return text(this.height);
    if (path === '/fee-estimates') return json({ '3': 2 });
    if (path === '/tx' && body !== null) { try { return text(this.broadcast(body.trim())); } catch (e) { return { code: 400, body: (e as Error).message, type: 'text/plain' }; } }
    let m = /^\/address\/([^/]+)\/utxo$/.exec(path);
    if (m) return json(this.utxosOf(decodeURIComponent(m[1] as string)).map(u => ({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: true, block_height: u.height } })));
    m = /^\/address\/([^/]+)\/txs$/.exec(path);
    if (m) { const a = decodeURIComponent(m[1] as string); return json(this.txs.filter(t => t.vout.some(o => o.scriptpubkey_address === a) || t.vin.some(v => this.txs.find(p => p.txid === v.txid)?.vout[v.vout]?.scriptpubkey_address === a)).map(t => this.dto(t))); }
    m = /^\/address\/([^/]+)$/.exec(path);
    if (m) { const a = decodeURIComponent(m[1] as string); const funded = this.fundedByAddr.get(a) ?? 0; const live = this.utxosOf(a).reduce((s, u) => s + u.value, 0); return json({ chain_stats: { funded_txo_sum: funded, spent_txo_sum: funded - live }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }); }
    m = /^\/tx\/([0-9a-f]{64})$/.exec(path);
    if (m) { const t = this.txs.find(x => x.txid === m![1]); return t ? json(this.dto(t)) : { code: 404, body: 'not found', type: 'text/plain' }; }
    return { code: 404, body: 'not found', type: 'text/plain' };
  }
  private dto(t: RegtestTx) { return { txid: t.txid, status: { confirmed: true, block_height: t.height }, vin: t.vin, vout: t.vout }; }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        const r = this.respond(req.url ?? '', req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : null);
        res.writeHead(r.code, { 'content-type': r.type }); res.end(r.body);
      });
    });
    await new Promise<void>(ok => this.server.listen(0, '127.0.0.1', ok));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }
  async stop(): Promise<void> { await new Promise<void>(ok => this.server.close(() => ok())); }
}
