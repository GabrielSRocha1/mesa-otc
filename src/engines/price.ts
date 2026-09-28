/**
 * Price Engine — múltiplas fontes, mediana ponderada, detecção de anomalia, snapshot com validade e cálculo econômico.
 * Nunca decide se a Deal avança: reporta. Falha de uma fonte é tolerada; abaixo do mínimo de fontes → PRICE_UNAVAILABLE.
 */
import { newId, type CanonicalAsset, type Pricing } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';

/** Fontes podem devolver o carimbo da cotação; sem carimbo assume-se "agora" (só aceitável para fontes push em tempo real). */
export interface PriceSource { name: string; weight: number; getPriceUsd(assetId: string): Promise<number | { priceUsd: number; at: number }> }
export interface Quote { source: string; assetId: string; priceUsd: number; at: number; weight: number }
export interface PriceSnapshot { id: string; takenAt: number; validUntil: number; quotes: Quote[]; reference: Record<string, number>; dispersionBps: Record<string, number>; anomaly: boolean; anomalyReasons: string[]; sourcesOk: number }
export interface PriceEngineConfig { minSources: number; maxDispersionBps: number; maxSourceDeviationBps: number; ttlMs: number; sourceTimeoutMs: number; maxQuoteAgeMs: number; breaker: { threshold: number; windowMs: number; cooldownMs: number } }
export const DEFAULT_PRICE_CONFIG: PriceEngineConfig = { minSources: 3, maxDispersionBps: 150, maxSourceDeviationBps: 300, ttlMs: 30_000, sourceTimeoutMs: 3_000, maxQuoteAgeMs: 60_000, breaker: { threshold: 3, windowMs: 120_000, cooldownMs: 300_000 } };

function weightedMedian(values: { v: number; w: number }[]): number {
  const s = [...values].sort((a, b) => a.v - b.v); const total = s.reduce((x, y) => x + y.w, 0); let acc = 0;
  for (const it of s) { acc += it.w; if (acc >= total / 2) return it.v; } return s[s.length - 1]?.v ?? 0;
}
const toDec = (n: number, places = 8): string => n.toFixed(places).replace(/\.?0+$/, '');

export class PriceEngine {
  private anomalies: number[] = []; private breakerOpenUntil = 0;
  constructor(private readonly sources: PriceSource[], private readonly cfg: PriceEngineConfig = DEFAULT_PRICE_CONFIG, private readonly now: () => number = () => Date.now()) {}

  /** Circuit breaker (RS-031): anomalias repetidas na janela abrem o disjuntor; nenhuma Deal avança até o cooldown. */
  breakerState(): { open: boolean; until: number; recentAnomalies: number } { const t = this.now(); this.anomalies = this.anomalies.filter(a => a > t - this.cfg.breaker.windowMs); return { open: this.breakerOpenUntil > t, until: this.breakerOpenUntil, recentAnomalies: this.anomalies.length }; }
  private recordAnomaly(): void { const t = this.now(); this.anomalies.push(t); this.anomalies = this.anomalies.filter(a => a > t - this.cfg.breaker.windowMs); if (this.anomalies.length >= this.cfg.breaker.threshold) { this.breakerOpenUntil = t + this.cfg.breaker.cooldownMs; this.anomalies = []; } }
  /** Fecha o disjuntor manualmente (operador, após investigação). */
  resetBreaker(): void { this.breakerOpenUntil = 0; this.anomalies = []; }

  async quote(assetIds: string[]): Promise<PriceSnapshot> {
    const b = this.breakerState(); if (b.open) throw new DomainError('PRICE_UNAVAILABLE', 'Disjuntor de preço aberto após anomalias repetidas', { until: b.until });
    const quotes: Quote[] = []; const failures: string[] = [];
    await Promise.all(this.sources.map(async src => {
      for (const id of assetIds) {
        try { let timer: NodeJS.Timeout | undefined; const raw = await Promise.race([src.getPriceUsd(id), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), this.cfg.sourceTimeoutMs); })]).finally(() => clearTimeout(timer)); const p = typeof raw === 'number' ? raw : raw.priceUsd; const at = typeof raw === 'number' ? this.now() : raw.at; if (!(p > 0) || !Number.isFinite(p)) throw new Error('preço inválido'); if (this.now() - at > this.cfg.maxQuoteAgeMs) throw new Error(`cotação obsoleta (${this.now() - at} ms)`); quotes.push({ source: src.name, assetId: id, priceUsd: p, at, weight: src.weight }); }
        catch (e) { failures.push(`${src.name}:${id}:${(e as Error).message}`); }
      }
    }));
    const reference: Record<string, number> = {}; const dispersionBps: Record<string, number> = {}; const anomalyReasons: string[] = []; let sourcesOk = Infinity;
    for (const id of assetIds) {
      const q = quotes.filter(x => x.assetId === id); sourcesOk = Math.min(sourcesOk, q.length);
      if (q.length < this.cfg.minSources) throw new DomainError('PRICE_UNAVAILABLE', `Fontes insuficientes para ${id}: ${q.length}/${this.cfg.minSources}`, { failures });
      const med = weightedMedian(q.map(x => ({ v: x.priceUsd, w: x.weight }))); reference[id] = med;
      const devs = q.map(x => Math.abs(x.priceUsd / med - 1) * 10000); const disp = Math.round(Math.max(...devs) * 2) ; dispersionBps[id] = Math.round((Math.max(...q.map(x => x.priceUsd)) / Math.min(...q.map(x => x.priceUsd)) - 1) * 10000);
      if (dispersionBps[id] > this.cfg.maxDispersionBps) anomalyReasons.push(`dispersão ${dispersionBps[id]} bps em ${id} acima de ${this.cfg.maxDispersionBps}`);
      q.forEach((x, i) => { if ((devs[i] ?? 0) > this.cfg.maxSourceDeviationBps) anomalyReasons.push(`${x.source} desvia ${Math.round(devs[i] ?? 0)} bps da mediana em ${id}`); });
      void disp;
    }
    if (anomalyReasons.length > 0) this.recordAnomaly();
    return { id: newId('PS'), takenAt: this.now(), validUntil: this.now() + this.cfg.ttlMs, quotes, reference, dispersionBps, anomaly: anomalyReasons.length > 0, anomalyReasons, sourcesOk };
  }

  /** Economia da operação (RF-033). Inteiros em unidades base; USD como decimal string. */
  computeEconomics(p: { assetIn: CanonicalAsset; assetOut: CanonicalAsset; amountInBase: string; snapshot: PriceSnapshot; discountBps: number; commissionBps?: number; commissionSplitBps?: number[]; platformFeeBps: number; paymasterShareBps: number; maxSlippageBps: number; maxPriceDriftBps: number; networkCostUsd: { in: string; out: string } }): { pricing: Pricing; amountOutBase: string; feeBase: string } {
    const pIn = p.snapshot.reference[p.assetIn.assetId]; const pOut = p.snapshot.reference[p.assetOut.assetId];
    if (!pIn || !pOut) throw new DomainError('PRICE_UNAVAILABLE', 'snapshot não cobre os ativos');
    // usdIn = amountIn * pIn ; amountOut = usdIn*(1-disc)/pOut — feito com inteiros escalados para evitar erro de ponto flutuante.
    const pInS = BigInt(Math.round(pIn * 1e12)); const pOutS = BigInt(Math.round(pOut * 1e12));
    const amountIn = BigInt(p.amountInBase); const decIn = 10n ** BigInt(p.assetIn.decimals); const decOut = 10n ** BigInt(p.assetOut.decimals);
    const usdInS = amountIn * pInS / decIn; // USD * 1e12
    const commissionBps = p.commissionBps ?? 0; if (p.discountBps + commissionBps > 10000) throw new DomainError('INVALID_INPUT', 'Deságio + comissão não podem ultrapassar 100%');
    // netValue = gross − discount − commission (regra central; a divisão entre Pay Masters é distribuição da comissão, não desconto adicional)
    const usdOutS = usdInS * BigInt(10000 - p.discountBps - commissionBps) / 10000n; const usdCommissionS = usdInS * BigInt(commissionBps) / 10000n;
    const amountOut = usdOutS * decOut / pOutS;
    const fee = amountOut * BigInt(p.platformFeeBps) / 10000n; const net = amountOut - fee;
    const usd = (s: bigint) => (Number(s) / 1e12).toFixed(2);
    return { amountOutBase: amountOut.toString(), feeBase: fee.toString(), pricing: {
      referencePriceInUsd: toDec(pIn), referencePriceOutUsd: toDec(pOut), quoteTimestamp: p.snapshot.takenAt, priceValidUntil: p.snapshot.validUntil,
      usdValueIn: usd(usdInS), usdValueOut: usd(usdOutS), discountBps: p.discountBps, commissionBps, commissionSplitBps: p.commissionSplitBps ?? [], usdCommission: usd(usdCommissionS), platformFeeBps: p.platformFeeBps, paymasterShareBps: p.paymasterShareBps, maxSlippageBps: p.maxSlippageBps, maxPriceDriftBps: p.maxPriceDriftBps,
      networkCostEstimateUsd: p.networkCostUsd, netAmountSellerBase: net.toString(), priceSnapshotId: p.snapshot.id } };
  }

  /** Deriva de preço entre a cotação assinada e o mercado atual (ADR-009): fora da banda ⇒ não liquida. */
  driftBps(signed: Pricing, current: PriceSnapshot, assetInId: string, assetOutId: string): number {
    const rIn = Number(signed.referencePriceInUsd) / Number(signed.referencePriceOutUsd); const cIn = (current.reference[assetInId] ?? 0) / (current.reference[assetOutId] ?? 1);
    return Math.round(Math.abs(cIn / rIn - 1) * 10000);
  }
}

/** Fonte estática (dev/teste) com falhas injetáveis. */
export class StaticPriceSource implements PriceSource {
  down = false; skew = 1; /** se definido, a fonte reporta cotações com este carimbo (simula preço obsoleto) */ staleAt: number | null = null;
  constructor(public readonly name: string, public readonly weight: number, private readonly prices: Record<string, number>) {}
  setPrice(assetId: string, price: number): void { this.prices[assetId] = price; }
  async getPriceUsd(assetId: string): Promise<number | { priceUsd: number; at: number }> { if (this.down) throw new Error('oracle indisponível'); const p = this.prices[assetId]; if (p === undefined) throw new Error('sem cotação'); return this.staleAt !== null ? { priceUsd: p * this.skew, at: this.staleAt } : p * this.skew; }
}
