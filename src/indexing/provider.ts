/**
 * Operar Indexado — fonte do índice. VerumSwapIndexProvider consulta o endpoint SERVER-SIDE do motor
 * de swap da Verum; MockIndexProvider serve dev/teste (sem rede). Ambos passam pelo MESMO validador:
 * preço de referência = MEDIANA; exige ≥ minProviders e dispersão ≤ maxDispersionBps; senão falha
 * FECHADO (INDEX_UNRELIABLE/INDEX_NO_ROUTE). Usa o preço BRUTO (sem a fee de 0,075% do swap).
 */
import { DomainError } from '../domain/errors.js';
import { impliedPriceE18, medianBigint, dispersionBps } from './math.js';
import type { IndexPriceProvider, IndexRequest, IndexSnapshot, IndexSource, RawQuote } from './types.js';

export interface SnapshotPolicy { minProviders: number; maxDispersionBps: number }

/** Converte cotações cruas (grossOut) em snapshot validado (mediana + dispersão). Compartilhado real/mock. */
export function buildSnapshot(req: IndexRequest, quotes: RawQuote[], policy: SnapshotPolicy, now: number): IndexSnapshot {
  // Rota inexistente: o motor não cotou o par (ativo fora das redes suportadas).
  if (quotes.length === 0) throw new DomainError('INDEX_NO_ROUTE', 'Sem rota de preço para o par no Verum Swap');
  const fresh = quotes.filter(q => q.grossOut > 0n && (q.expiresAt == null || q.expiresAt > now));
  if (fresh.length === 0) throw new DomainError('INDEX_NO_QUOTE', 'Nenhuma cotação válida (todas vencidas ou zeradas)');
  const sources: IndexSource[] = fresh.map(q => ({ provider: q.provider, priceE18: impliedPriceE18(q.grossOut, req.baseAmount, req.baseAsset.decimals, req.quoteAsset.decimals), ...(q.quoteId ? { quoteId: q.quoteId } : {}) }));
  if (sources.length < policy.minProviders) throw new DomainError('INDEX_UNRELIABLE', `Fontes insuficientes: ${sources.length}/${policy.minProviders}`, { providers: sources.length, minProviders: policy.minProviders });
  const prices = sources.map(s => s.priceE18);
  const priceE18 = medianBigint(prices);
  const disp = dispersionBps(prices);
  if (disp > BigInt(policy.maxDispersionBps)) throw new DomainError('INDEX_UNRELIABLE', `Dispersão ${disp} bps acima do limite ${policy.maxDispersionBps}`, { dispersionBps: disp.toString(), maxDispersionBps: policy.maxDispersionBps });
  return { priceE18, sources, dispersionBps: disp, observedAt: now };
}

export interface VerumSwapConfig { baseUrl: string; apiKey: string; timeoutMs: number; minProviders: number; maxDispersionBps: number }

export class VerumSwapIndexProvider implements IndexPriceProvider {
  readonly label = 'Verum Swap';
  constructor(private readonly cfg: VerumSwapConfig, private readonly fetchFn: typeof fetch = fetch, private readonly now: () => number = () => Date.now()) {}

  async snapshot(req: IndexRequest): Promise<IndexSnapshot> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/api/swap/quote`;
    const body = JSON.stringify({
      baseAsset: { network: req.baseAsset.network, chainId: req.baseAsset.chainId, contractOrMint: req.baseAsset.contractOrMint, decimals: req.baseAsset.decimals, symbol: req.baseAsset.symbol },
      quoteAsset: { network: req.quoteAsset.network, chainId: req.quoteAsset.chainId, contractOrMint: req.quoteAsset.contractOrMint, decimals: req.quoteAsset.decimals, symbol: req.quoteAsset.symbol },
      baseAmount: req.baseAmount.toString(),
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    let payload: unknown;
    try {
      // Sem cookies, sem analytics, sem log de IP/carteira (RF-ouro §2). Sem retry silencioso.
      const res = await this.fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.cfg.apiKey}` }, body, signal: ctrl.signal });
      if (!res.ok) throw new DomainError('INDEX_UNRELIABLE', `Motor de swap respondeu ${res.status}`, { status: res.status });
      payload = await res.json();
    } catch (e) {
      if (e instanceof DomainError) throw e;
      const msg = (e as Error).name === 'AbortError' ? `timeout após ${this.cfg.timeoutMs} ms` : (e as Error).message;
      throw new DomainError('INDEX_UNRELIABLE', `Falha ao consultar o Verum Swap (${msg})`);
    } finally { clearTimeout(timer); }
    const list = asQuoteList(payload);
    if (!list) throw new DomainError('INDEX_UNRELIABLE', 'Resposta do Verum Swap em formato inesperado');
    const quotes: RawQuote[] = [];
    let idx = 0;
    for (const item of list) {
      idx++;
      const raw = (item && typeof item === 'object') ? item as Record<string, unknown> : null;
      if (!raw) continue;
      const grossOut = coerceMinUnits(pickFirst(raw, GROSS_OUT_KEYS));
      if (grossOut === null) continue;               // sem saída inteira em unidades mínimas → item malformado (ignora, não derruba)
      const provider = pickString(raw, PROVIDER_KEYS) ?? `src-${idx}`; // provedor é só rótulo; sem nome, numera (não descarta cotação válida)
      const quoteId = pickString(raw, QUOTE_ID_KEYS);
      const expiresAt = coerceEpochMs(pickFirst(raw, EXPIRES_KEYS));
      quotes.push({ provider, grossOut, ...(quoteId ? { quoteId } : {}), ...(expiresAt !== null ? { expiresAt } : {}) });
    }
    return buildSnapshot(req, quotes, { minProviders: this.cfg.minProviders, maxDispersionBps: this.cfg.maxDispersionBps }, this.now());
  }
}

// ---- Tolerância de formato do motor de swap (campos/invólucros variam entre versões/agregadores) ----
const GROSS_OUT_KEYS = ['grossOut', 'grossAmountOut', 'amountOut', 'outAmount', 'outputAmount', 'toAmount', 'dstAmount', 'destAmount', 'toTokenAmount', 'out'];
const PROVIDER_KEYS = ['provider', 'source', 'name', 'dex', 'aggregator', 'venue', 'exchange', 'pool'];
const QUOTE_ID_KEYS = ['quoteId', 'quote_id', 'id', 'routeId', 'ref'];
const EXPIRES_KEYS = ['expiresAt', 'expires_at', 'expiry', 'validUntil', 'valid_until', 'deadline'];
const LIST_KEYS = ['quotes', 'data', 'results', 'routes', 'items', 'offers', 'sources'];

/** Acha a lista de cotações no payload: array direto ou sob um invólucro comum ({quotes|data|results|…}). */
function asQuoteList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const k of LIST_KEYS) if (Array.isArray(o[k])) return o[k] as unknown[];
    // às vezes vem aninhado: { data: { quotes: [...] } }
    for (const k of LIST_KEYS) { const inner = o[k]; if (inner && typeof inner === 'object') { for (const k2 of LIST_KEYS) if (Array.isArray((inner as Record<string, unknown>)[k2])) return (inner as Record<string, unknown>)[k2] as unknown[]; } }
  }
  return null;
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const v = pickFirst(obj, keys);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
/**
 * Coage um valor em unidades mínimas INTEIRAS para bigint. Aceita string decimal-inteira ou number inteiro
 * (inclusive aninhado em { amount|value|raw }). Rejeita fração/float (unidades mínimas são inteiras) e lixo.
 */
function coerceMinUnits(v: unknown): bigint | null {
  if (typeof v === 'object' && v !== null) return coerceMinUnits(pickFirst(v as Record<string, unknown>, ['amount', 'value', 'raw', 'wei', 'lamports']));
  if (typeof v === 'bigint') return v > 0n ? v : null;
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? BigInt(v) : null;
  if (typeof v === 'string') { const s = v.trim(); if (!/^[0-9]+$/.test(s)) return null; try { const b = BigInt(s); return b > 0n ? b : null; } catch { return null; } }
  return null;
}
/** Normaliza expiração para epoch ms: segundos (< 1e12) viram ms; strings numéricas aceitas. undefined → null. */
function coerceEpochMs(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) n = Number(v.trim());
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n); // < 1e12 ⇒ está em segundos
}

/**
 * Mock para dev/teste (SEM rede). `quotesFor` controla as cotações cruas por requisição (determinístico).
 * `staticUsd` sintetiza N provedores em torno de um preço USD por símbolo — experiência de dev utilizável.
 */
export class MockIndexProvider implements IndexPriceProvider {
  readonly label = 'Verum Swap';
  constructor(
    private readonly quotesFor: (req: IndexRequest) => RawQuote[],
    private readonly policy: SnapshotPolicy,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Provedor de dev: preço cruzado a partir de um mapa de preços USD por símbolo (2 fontes próximas). */
  static staticUsd(usdBySymbol: Record<string, number>, policy: SnapshotPolicy, now: () => number = () => Date.now()): MockIndexProvider {
    return new MockIndexProvider(req => {
      const pb = usdBySymbol[req.baseAsset.symbol.toUpperCase()];
      const pq = usdBySymbol[req.quoteAsset.symbol.toUpperCase()];
      if (!pb || !pq) return []; // sem preço → sem rota (fecha a UI com motivo claro)
      // grossOut (unidades mínimas de quote) ≈ baseAmount(base) × (pb/pq), via inteiros escalados 1e12.
      const sb = BigInt(Math.round(pb * 1e12)); const sq = BigInt(Math.round(pq * 1e12));
      const decB = 10n ** BigInt(req.baseAsset.decimals); const decQ = 10n ** BigInt(req.quoteAsset.decimals);
      const mid = (req.baseAmount * sb * decQ) / (sq * decB);
      // Duas fontes: ±5 bps em torno do mid (dispersão ~10 bps < limite padrão 100).
      return [
        { provider: 'mm-a', grossOut: (mid * 9995n) / 10_000n, quoteId: 'mock-a' },
        { provider: 'mm-b', grossOut: (mid * 10_005n) / 10_000n, quoteId: 'mock-b' },
      ];
    }, policy, now);
  }

  async snapshot(req: IndexRequest): Promise<IndexSnapshot> {
    return buildSnapshot(req, this.quotesFor(req), this.policy, this.now());
  }
}
