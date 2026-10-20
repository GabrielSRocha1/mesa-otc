/**
 * LndRestService — cliente LND via REST (fetch nativo + macaroon no header + TLS do nó).
 *
 * Sem dependências novas: usa `fetch` do Node e o `Agent` do `undici` (embutido) para confiar no cert
 * self-signed do LND. Macaroon de escopo mínimo (invoice + offchain + readonly) vai no header
 * `Grpc-Metadata-macaroon`. O LND serializa bytes em base64 — convertemos hex↔base64 nas bordas.
 *
 * Subconjunto de endpoints usado:
 *   GET  /v1/getinfo                      → node info
 *   GET  /v1/balance/channels             → liquidez de canais (precheck)
 *   POST /v2/invoices/hodl                → hold invoice com payment_hash fixo (= htlcHash)
 *   GET  /v1/payreq/{bolt11}              → decode/validação de invoice
 *   POST /v2/router/send                  → paga (stream de updates; final = SUCCEEDED + preimage)
 *   GET  /v2/router/track/{hashHex}       → consulta pagamento (idempotência/recuperação)
 */
import { Agent } from 'undici';
import type { LndSettings } from '../../config.js';
import type { LightningService, LnInvoice, LnPayment, LnNodeInfo, LnBalance } from './types.js';

const hexToB64 = (hex: string): string => Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('base64');
const b64ToHex = (b64: string): string => Buffer.from(b64, 'base64').toString('hex');

export class LndRestService implements LightningService {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly dispatcher: Agent | undefined;
  constructor(private readonly cfg: LndSettings) {
    this.base = cfg.restUrl;
    this.headers = { 'Grpc-Metadata-macaroon': cfg.macaroonHex, 'content-type': 'application/json' };
    // TLS: só em https:// com cert presente (nó real). http:// (fake/local) usa o fetch default.
    if (cfg.restUrl.startsWith('https://') && cfg.tlsCert) {
      const ca = /BEGIN CERTIFICATE/.test(cfg.tlsCert) ? cfg.tlsCert : Buffer.from(cfg.tlsCert, 'base64').toString('utf8');
      this.dispatcher = new Agent({ connect: { ca, rejectUnauthorized: true } });
    } else this.dispatcher = undefined;
  }
  private async req<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const ctrl = new AbortController(); const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetch(this.base + path, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body), ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}), signal: ctrl.signal } as RequestInit);
      const text = await r.text();
      if (!r.ok) throw new Error(`LND ${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : {}) as T;
    } finally { if (t) clearTimeout(t); }
  }

  async getNodeInfo(): Promise<LnNodeInfo> {
    const r = await this.req<{ identity_pubkey: string; alias: string; chains: { chain: string }[] }>('GET', '/v1/getinfo');
    return { pubkey: r.identity_pubkey, alias: r.alias, chains: (r.chains ?? []).map(c => c.chain) };
  }
  async getBalance(): Promise<LnBalance> {
    const r = await this.req<{ local_balance?: { sat: string }; remote_balance?: { sat: string } }>('GET', '/v1/balance/channels');
    return { outboundSat: BigInt(r.local_balance?.sat ?? '0'), inboundSat: BigInt(r.remote_balance?.sat ?? '0') };
  }
  async addInvoice(paymentHash: string, amountSat: bigint, memo: string): Promise<LnInvoice> {
    const r = await this.req<{ payment_request: string }>('POST', '/v2/invoices/hodl', { hash: hexToB64(paymentHash), value: amountSat.toString(), memo, expiry: this.cfg.invoiceExpirySec.toString() });
    return { bolt11: r.payment_request, paymentHash: paymentHash.toLowerCase(), amountSat, expiresAt: Date.now() + this.cfg.invoiceExpirySec * 1000 };
  }
  async decodeInvoice(bolt11: string): Promise<LnInvoice> {
    const r = await this.req<{ payment_hash: string; num_satoshis: string; expiry: string; timestamp: string }>('GET', `/v1/payreq/${encodeURIComponent(bolt11)}`);
    return { bolt11, paymentHash: r.payment_hash.toLowerCase(), amountSat: BigInt(r.num_satoshis ?? '0'), expiresAt: (Number(r.timestamp ?? 0) + Number(r.expiry ?? 0)) * 1000 };
  }
  async payInvoice(bolt11: string, opts?: { timeoutSec?: number; maxFeeSat?: bigint }): Promise<LnPayment> {
    const timeoutSec = opts?.timeoutSec ?? this.cfg.paymentTimeoutSec;
    // /v2/router/send devolve um stream NDJSON de updates; lemos até o estado final.
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), (timeoutSec + 5) * 1000);
    try {
      const r = await fetch(this.base + '/v2/router/send', { method: 'POST', headers: this.headers, ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}), signal: ctrl.signal, body: JSON.stringify({ payment_request: bolt11, timeout_seconds: timeoutSec, fee_limit_sat: (opts?.maxFeeSat ?? 1000n).toString(), no_inflight_updates: true }) } as RequestInit);
      const text = await r.text();
      // NDJSON: cada linha um { result: {...} }. Pegamos a última não-vazia.
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const last = lines.length ? JSON.parse(lines[lines.length - 1] as string) as { result?: { status?: string; payment_preimage?: string; payment_hash?: string; failure_reason?: string } } : null;
      const res = last?.result;
      if (res?.status === 'SUCCEEDED') return { status: 'succeeded', paymentHash: b64ToHex(res.payment_hash ?? ''), preimage: res.payment_preimage ? b64ToHex(res.payment_preimage) : null, feeSat: 0n };
      return { status: 'failed', paymentHash: res?.payment_hash ? b64ToHex(res.payment_hash) : '', preimage: null, feeSat: 0n, failureReason: res?.failure_reason ?? 'no_result' };
    } finally { clearTimeout(to); }
  }
  async lookupPayment(paymentHash: string): Promise<LnPayment> {
    try {
      const r = await this.req<{ status?: string; payment_preimage?: string }>('GET', `/v2/router/track/${paymentHash.replace(/^0x/, '')}`);
      if (r.status === 'SUCCEEDED') return { status: 'succeeded', paymentHash: paymentHash.toLowerCase(), preimage: r.payment_preimage ? b64ToHex(r.payment_preimage) : null, feeSat: 0n };
      if (r.status === 'FAILED') return { status: 'failed', paymentHash: paymentHash.toLowerCase(), preimage: null, feeSat: 0n };
      return { status: 'pending', paymentHash: paymentHash.toLowerCase(), preimage: null, feeSat: 0n };
    } catch { return { status: 'pending', paymentHash: paymentHash.toLowerCase(), preimage: null, feeSat: 0n }; }
  }
}
