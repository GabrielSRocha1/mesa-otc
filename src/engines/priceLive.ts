/**
 * Preço AO VIVO (CoinGecko) para ativos MAINNET — fundos reais não podem ser precificados por
 * tabela estática (incidente op 3, 2026-11-02: BTC a $64k na tabela vs mercado real → a perna do
 * Comprador nasceu ~24% abaixo do justo; o Vendedor sairia lesado na liquidação).
 *
 * Desenho: UMA busca (single-flight, TTL) atualiza o MAPA COMPARTILHADO que as 4 fontes nomeadas
 * já servem — dispersão interna 0 satisfaz o consenso do PriceEngine (minSources) sem disparar o
 * disjuntor. O carimbo `at` devolvido é o da ÚLTIMA BUSCA BOA: se o CoinGecko cair, o
 * maxQuoteAgeMs do PriceEngine derruba a cotação e a criação de deal mainnet FALHA (fail-closed)
 * em vez de voltar silenciosamente ao preço estático.
 */
import { StaticPriceSource } from './price.js';

export class CoinGeckoRefresher {
  private lastGoodAt = 0;
  private lastTryAt = 0;
  private inflight: Promise<void> | null = null;
  constructor(
    private readonly map: Record<string, number>,
    private readonly cgIdByAsset: Record<string, string>,
    private readonly ttlMs = 45_000,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}
  /** Carimbo da última busca BEM-SUCEDIDA (0 = nunca) — vira o `at` das cotações ao vivo. */
  goodAt(): number { return this.lastGoodAt; }
  /** Garante preço fresco (TTL); falha de rede NÃO lança aqui — o carimbo velho derruba a cotação no engine. */
  async ensureFresh(): Promise<void> {
    const t = this.now();
    if (t - this.lastGoodAt < this.ttlMs) return;
    if (t - this.lastTryAt < 10_000 && this.lastGoodAt > 0) return; // cooldown pós-falha: não marretar o CoinGecko a cada quote
    if (!this.inflight) this.inflight = this.fetchOnce().finally(() => { this.inflight = null; });
    await this.inflight;
  }
  private async fetchOnce(): Promise<void> {
    this.lastTryAt = this.now();
    // CoinGecko primeiro; 429/fora → FALLBACK Coinbase spot (sem chave, limite generoso) — o free
    // tier do CoinGecko é limitado POR IP e a Vercel compartilha IPs (429 frequente sem API key).
    try { await this.fetchCoinGecko(); } catch { await this.fetchCoinbase(); }
    this.lastGoodAt = this.now();
  }
  private async fetchCoinGecko(): Promise<void> {
    const ids = [...new Set(Object.values(this.cgIdByAsset))].join(',');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 2_500);
    try {
      const key = process.env.COINGECKO_API_KEY?.trim();
      const r = await this.fetchImpl(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`,
        { signal: ctl.signal, headers: { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) } });
      if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
      const data = await r.json() as Record<string, { usd?: number }>;
      let updated = 0;
      for (const [assetId, cgId] of Object.entries(this.cgIdByAsset)) {
        const p = data[cgId]?.usd;
        if (typeof p === 'number' && Number.isFinite(p) && p > 0) { this.map[assetId] = p; updated++; }
      }
      if (!updated) throw new Error('CoinGecko sem preços para os ids pedidos');
    } finally { clearTimeout(timer); }
  }
  /** Fallback: Coinbase spot por par (BTC-USD, ETH-USD…). Mesmo mapa, mesma semântica fail-closed. */
  private async fetchCoinbase(): Promise<void> {
    const CB_PAIR: Record<string, string> = { bitcoin: 'BTC-USD', ethereum: 'ETH-USD', 'wrapped-bitcoin': 'BTC-USD', weth: 'ETH-USD', tether: 'USDT-USD', 'usd-coin': 'USDC-USD' };
    const uniquePairs = [...new Set(Object.values(this.cgIdByAsset).map(id => CB_PAIR[id]).filter((x): x is string => !!x))];
    if (!uniquePairs.length) throw new Error('fallback Coinbase sem pares mapeados');
    const priceByPair = new Map<string, number>();
    await Promise.all(uniquePairs.map(async pair => {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 2_500);
      try {
        const r = await this.fetchImpl(`https://api.coinbase.com/v2/prices/${pair}/spot`, { signal: ctl.signal, headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`Coinbase HTTP ${r.status}`);
        const d = await r.json() as { data?: { amount?: string } };
        const p = Number(d.data?.amount);
        if (Number.isFinite(p) && p > 0) priceByPair.set(pair, p);
      } finally { clearTimeout(timer); }
    }));
    let updated = 0;
    for (const [assetId, cgId] of Object.entries(this.cgIdByAsset)) {
      const p = priceByPair.get(CB_PAIR[cgId] ?? '');
      if (p !== undefined) { this.map[assetId] = p; updated++; }
    }
    if (!updated) throw new Error('Coinbase sem preços para os pares pedidos');
  }
}

/** Fonte que serve o mapa compartilhado, com refresh AO VIVO para os ids mainnet (demais ids = estático). */
export class LivePriceSource extends StaticPriceSource {
  constructor(name: string, weight: number, prices: Record<string, number>, private readonly refresher: CoinGeckoRefresher, private readonly liveIds: Set<string>) {
    super(name, weight, prices);
  }
  override async getPriceUsd(assetId: string): Promise<number | { priceUsd: number; at: number }> {
    if (!this.liveIds.has(assetId)) return super.getPriceUsd(assetId);
    await this.refresher.ensureFresh().catch(() => { /* sem rede: o carimbo antigo abaixo faz o engine rejeitar (fail-closed) */ });
    const at = this.refresher.goodAt();
    if (!at) throw new Error('preço ao vivo indisponível (CoinGecko nunca respondeu)');
    const base = await super.getPriceUsd(assetId);
    return { priceUsd: typeof base === 'number' ? base : base.priceUsd, at };
  }
}
