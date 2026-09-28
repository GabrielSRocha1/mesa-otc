/**
 * Risk Engine — screening de carteiras, limites, anomalia de preço e decisão ALLOW/REVIEW/BLOCK (RS-050/051).
 * Nunca liquida nem desbloqueia. Provedores de screening são injetáveis (denylist local em dev).
 */
import { newId, type Deal, type Network, type RiskEvent } from '../domain/types.js';
import type { Store } from '../db/repository.js';

export interface WalletScreening { screen(network: Network, address: string): Promise<{ level: 'LOW' | 'MEDIUM' | 'HIGH'; findings: string[] }> }
export interface RiskConfig { maxDealUsd: number; maxWalletDailyUsd: number; maxOpenDealsPerWallet: number }
export const DEFAULT_RISK_CONFIG: RiskConfig = { maxDealUsd: 100_000, maxWalletDailyUsd: 250_000, maxOpenDealsPerWallet: 10 };

export class DenylistScreening implements WalletScreening {
  constructor(private readonly deny: Set<string> = new Set(), private readonly review: Set<string> = new Set()) {}
  async screen(_network: Network, address: string) { const a = address.toLowerCase(); if ([...this.deny].some(x => x.toLowerCase() === a)) return { level: 'HIGH' as const, findings: ['endereço em lista de sanção/bloqueio'] }; if ([...this.review].some(x => x.toLowerCase() === a)) return { level: 'MEDIUM' as const, findings: ['interação recente com contrato marcado'] }; return { level: 'LOW' as const, findings: [] }; }
}

export class RiskEngine {
  constructor(private readonly store: Store, private readonly screening: WalletScreening, private readonly cfg: RiskConfig = DEFAULT_RISK_CONFIG, private readonly now: () => number = () => Date.now()) {}
  private async record(e: Omit<RiskEvent, 'id' | 'at'>): Promise<RiskEvent> { const ev: RiskEvent = { ...e, id: newId('RK'), at: this.now() }; await this.store.insertRiskEvent(ev); return ev; }

  async assessWallet(dealId: string | null, network: Network, address: string): Promise<{ level: 'LOW' | 'MEDIUM' | 'HIGH'; decision: 'ALLOW' | 'REVIEW' | 'BLOCK' }> {
    const s = await this.screening.screen(network, address);
    const decision = s.level === 'HIGH' ? 'BLOCK' : s.level === 'MEDIUM' ? 'REVIEW' : 'ALLOW';
    if (decision !== 'ALLOW') await this.record({ dealId, wallet: address, rule: 'RS-051 · wallet-screening', severity: s.level === 'HIGH' ? 'CRITICAL' : 'MEDIUM', decision, evidence: { findings: s.findings, network } });
    return { level: s.level, decision };
  }
  async assessDeal(deal: Deal, usdValue: number): Promise<'ALLOW' | 'REVIEW' | 'BLOCK'> {
    if (usdValue > this.cfg.maxDealUsd) { await this.record({ dealId: deal.id, wallet: null, rule: 'RS-050 · max-deal-usd', severity: 'HIGH', decision: 'BLOCK', evidence: { usdValue, max: this.cfg.maxDealUsd } }); return 'BLOCK'; }
    const open = await this.store.listDeals({ states: ['AWAITING_SIGNATURES', 'FULLY_SIGNED', 'SETTLEMENT_VALIDATION', 'SETTLING'], participant: deal.createdBy });
    if (open.length > this.cfg.maxOpenDealsPerWallet) { await this.record({ dealId: deal.id, wallet: deal.createdBy, rule: 'RS-050 · max-open-deals', severity: 'MEDIUM', decision: 'REVIEW', evidence: { open: open.length } }); return 'REVIEW'; }
    return 'ALLOW';
  }
  async priceAnomaly(dealId: string, reasons: string[]): Promise<void> { await this.record({ dealId, wallet: null, rule: 'RS-031 · price-anomaly', severity: 'HIGH', decision: 'BLOCK', evidence: { reasons } }); }
  async settlementIncident(dealId: string, rule: string, evidence: Record<string, unknown>): Promise<void> { await this.record({ dealId, wallet: null, rule, severity: 'CRITICAL', decision: 'BLOCK', evidence }); }
}
