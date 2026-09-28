/**
 * Liquidity Engine — agrega profundidade de múltiplas venues, estima slippage para o tamanho e decide suficiência.
 * Em rotas P2P (v1) valida sanidade de mercado + saldo/escrow (RF-043). Falha de venue tolerada; nenhuma venue ⇒ LIQUIDITY_UNAVAILABLE.
 */
import type { CanonicalAsset } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';

export interface LiquiditySource { name: string; trust: number; getDepth(assetId: string): Promise<{ depthUsd: number; slippageBpsPerMillion: number; volume24hUsd: number }> }
export interface LiquidityAssessment { sufficient: boolean; sizeUsd: number; depthUsd: number; slippageBps: number; coverage: number; venues: { name: string; depthUsd: number; slippageBps: number; trust: number }[]; failures: string[]; reasons: string[]; assessedAt: number }
export interface LiquidityConfig { maxSizeToDepthRatio: number; minVenues: number }
export const DEFAULT_LIQUIDITY_CONFIG: LiquidityConfig = { maxSizeToDepthRatio: 0.2, minVenues: 1 };

export class LiquidityEngine {
  constructor(private readonly sources: LiquiditySource[], private readonly cfg: LiquidityConfig = DEFAULT_LIQUIDITY_CONFIG, private readonly now: () => number = () => Date.now()) {}
  async assess(p: { assetIn: CanonicalAsset; assetOut: CanonicalAsset; sizeUsd: number; maxSlippageBps: number }): Promise<LiquidityAssessment> {
    const venues: LiquidityAssessment['venues'] = []; const failures: string[] = [];
    await Promise.all(this.sources.map(async s => { try { const dIn = await s.getDepth(p.assetIn.assetId); const dOut = await s.getDepth(p.assetOut.assetId); const depthUsd = Math.min(dIn.depthUsd, dOut.depthUsd); venues.push({ name: s.name, depthUsd, slippageBps: Math.round(p.sizeUsd / 1e6 * Math.max(dIn.slippageBpsPerMillion, dOut.slippageBpsPerMillion)), trust: s.trust }); } catch (e) { failures.push(`${s.name}:${(e as Error).message}`); } }));
    if (venues.length < this.cfg.minVenues) throw new DomainError('LIQUIDITY_UNAVAILABLE', 'Nenhuma fonte de liquidez disponível', { failures });
    const depthUsd = venues.reduce((a, v) => a + v.depthUsd * v.trust, 0); const slippageBps = Math.max(1, Math.round(venues.reduce((a, v) => a + v.slippageBps * v.trust, 0) / venues.reduce((a, v) => a + v.trust, 0)));
    const reasons: string[] = [];
    if (p.sizeUsd > depthUsd * this.cfg.maxSizeToDepthRatio) reasons.push(`tamanho ${p.sizeUsd.toFixed(2)} USD excede ${this.cfg.maxSizeToDepthRatio * 100}% da profundidade ${depthUsd.toFixed(2)} USD`);
    if (slippageBps > p.maxSlippageBps) reasons.push(`slippage estimado ${slippageBps} bps > tolerância ${p.maxSlippageBps} bps`);
    return { sufficient: reasons.length === 0, sizeUsd: p.sizeUsd, depthUsd, slippageBps, coverage: Math.min(1, depthUsd * this.cfg.maxSizeToDepthRatio / Math.max(p.sizeUsd, 1)), venues, failures, reasons, assessedAt: this.now() };
  }
}
export class StaticLiquiditySource implements LiquiditySource {
  down = false;
  constructor(public readonly name: string, public readonly trust: number, private readonly depths: Record<string, number>, private readonly slipPerMillion = 8) {}
  async getDepth(assetId: string): Promise<{ depthUsd: number; slippageBpsPerMillion: number; volume24hUsd: number }> { if (this.down) throw new Error('venue indisponível'); const d = this.depths[assetId]; if (d === undefined) throw new Error('sem profundidade'); return { depthUsd: d, slippageBpsPerMillion: this.slipPerMillion, volume24hUsd: d * 4 }; }
}
