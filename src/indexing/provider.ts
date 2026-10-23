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

/** Resposta esperada do motor: lista de cotações válidas por provedor (preço BRUTO, antes da fee do swap). */
interface EngineQuote { provider?: unknown; grossOut?: unknown; quoteId?: unknown; expiresAt?: unknown }

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
    const list = Array.isArray(payload) ? payload : Array.isArray((payload as { quotes?: unknown })?.quotes) ? (payload as { quotes: unknown[] }).quotes : null;
    if (!list) throw new DomainError('INDEX_UNRELIABLE', 'Resposta do Verum Swap em formato inesperado');
    const quotes: RawQuote[] = [];
    for (const raw of list as EngineQuote[]) {
      const provider = typeof raw?.provider === 'string' ? raw.provider : null;
      const grossOutStr = typeof raw?.grossOut === 'string' || typeof raw?.grossOut === 'number' ? String(raw.grossOut) : null;
      if (!provider || !grossOutStr || !/^[0-9]+$/.test(grossOutStr)) continue; // descarta item malformado (não derruba o servidor)
      quotes.push({ provider, grossOut: BigInt(grossOutStr), ...(typeof raw.quoteId === 'string' ? { quoteId: raw.quoteId } : {}), ...(typeof raw.expiresAt === 'number' ? { expiresAt: raw.expiresAt } : {}) });
    }
    return buildSnapshot(req, quotes, { minProviders: this.cfg.minProviders, maxDispersionBps: this.cfg.maxDispersionBps }, this.now());
  }
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
