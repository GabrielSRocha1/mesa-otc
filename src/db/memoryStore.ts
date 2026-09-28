import type { AuditEvent, Deal, DealEvent, RiskEvent, SettlementRecord, SignatureRecord } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import type { NonceRow, Store } from './repository.js';

const clone = <T>(v: T): T => structuredClone(v);

/** Store em memória com as mesmas garantias lógicas do schema SQL. */
export class MemoryStore implements Store {
  private deals = new Map<string, Deal>();
  private events = new Map<string, DealEvent[]>();
  private sigs = new Map<string, SignatureRecord>();
  private nonces = new Map<string, NonceRow>();
  private settlements = new Map<string, SettlementRecord>();
  private risks: RiskEvent[] = [];
  private audit: AuditEvent[] = [];
  private idem = new Map<string, { requestHash: string; response: unknown }>();
  private idemAt = new Map<string, number>();

  async init(): Promise<void> { /* nada a preparar */ }
  async insertDeal(deal: Deal): Promise<void> { if (this.deals.has(deal.id)) throw new DomainError('VERSION_CONFLICT', 'Deal já existe'); this.deals.set(deal.id, clone(deal)); }
  async getDeal(id: string): Promise<Deal | null> { const d = this.deals.get(id); return d ? clone(d) : null; }
  async getDealByShareToken(token: string): Promise<Deal | null> { for (const d of this.deals.values()) if (d.shareToken === token) return clone(d); return null; }
  async saveDeal(deal: Deal, expectedVersion: number): Promise<void> {
    const cur = this.deals.get(deal.id); if (!cur) throw new DomainError('DEAL_NOT_FOUND', 'Deal não encontrada');
    if (cur.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Deal modificada concorrentemente', { expected: expectedVersion, actual: cur.version });
    this.deals.set(deal.id, clone({ ...deal, version: expectedVersion + 1 }));
  }
  async listDeals(filter?: { states?: string[]; participant?: string }): Promise<Deal[]> {
    return [...this.deals.values()].filter(d => (!filter?.states || filter.states.includes(d.state)) && (!filter?.participant || d.participants.some(p => p.address === filter.participant))).sort((a, b) => b.updatedAt - a.updatedAt).map(clone);
  }
  async appendDealEvent(ev: DealEvent): Promise<void> { const arr = this.events.get(ev.dealId) ?? []; if (arr.some(e => e.seq === ev.seq)) throw new DomainError('VERSION_CONFLICT', 'seq duplicado'); arr.push(clone(ev)); this.events.set(ev.dealId, arr); }
  async listDealEvents(dealId: string): Promise<DealEvent[]> { return clone(this.events.get(dealId) ?? []); }
  async lastDealEvent(dealId: string): Promise<DealEvent | null> { const arr = this.events.get(dealId); const last = arr?.[arr.length - 1]; return last ? clone(last) : null; }
  async insertSignature(sig: SignatureRecord): Promise<void> {
    if (sig.status === 'valid' && [...this.sigs.values()].some(s => s.dealId === sig.dealId && s.revision === sig.revision && s.role === sig.role && s.status === 'valid')) throw new DomainError('VERSION_CONFLICT', 'assinatura válida duplicada');
    this.sigs.set(sig.id, clone(sig));
  }
  async updateSignatureStatus(id: string, status: SignatureRecord['status']): Promise<void> { const s = this.sigs.get(id); if (s) s.status = status; }
  async listSignatures(dealId: string, revision?: number): Promise<SignatureRecord[]> { return [...this.sigs.values()].filter(s => s.dealId === dealId && (revision === undefined || s.revision === revision)).map(clone); }
  async insertNonce(n: NonceRow): Promise<void> { if (this.nonces.has(n.value)) throw new DomainError('NONCE_INVALID', 'nonce duplicado'); this.nonces.set(n.value, { ...n }); }
  async getNonce(value: string): Promise<NonceRow | null> { const n = this.nonces.get(value); return n ? { ...n } : null; }
  async consumeNonce(value: string, at: number): Promise<boolean> { const n = this.nonces.get(value); if (!n || n.consumedAt !== null) return false; n.consumedAt = at; return true; }
  async findOpenNonce(dealId: string, revision: number, role: string, now: number): Promise<NonceRow | null> { let best: NonceRow | null = null; for (const n of this.nonces.values()) if (n.kind === 'approval' && n.dealId === dealId && n.revision === revision && n.role === role && n.consumedAt === null && n.expiresAt > now && (!best || n.issuedAt > best.issuedAt)) best = n; return best ? { ...best } : null; }
  async purge(now: number, idempotencyTtlMs: number): Promise<{ nonces: number; idempotency: number }> { let nonces = 0, idempotency = 0; for (const [k, n] of this.nonces) if (n.expiresAt <= now) { this.nonces.delete(k); nonces++; } for (const [k, v] of this.idemAt) if (v <= now - idempotencyTtlMs) { this.idem.delete(k); this.idemAt.delete(k); idempotency++; } return { nonces, idempotency }; }
  async insertSettlement(s: SettlementRecord): Promise<boolean> { if (this.settlements.has(s.dealId)) return false; this.settlements.set(s.dealId, clone(s)); return true; }
  async updateSettlement(s: SettlementRecord): Promise<void> { this.settlements.set(s.dealId, clone(s)); }
  async getSettlement(dealId: string): Promise<SettlementRecord | null> { const s = this.settlements.get(dealId); return s ? clone(s) : null; }
  async insertRiskEvent(r: RiskEvent): Promise<void> { this.risks.push(clone(r)); }
  async listRiskEvents(dealId: string): Promise<RiskEvent[]> { return this.risks.filter(r => r.dealId === dealId).map(clone); }
  async appendAudit(a: AuditEvent): Promise<void> { if (this.audit.some(x => x.seq === a.seq)) throw new DomainError('VERSION_CONFLICT', 'audit seq duplicado'); this.audit.push(clone(a)); }
  async lastAudit(): Promise<AuditEvent | null> { const a = this.audit[this.audit.length - 1]; return a ? clone(a) : null; }
  async listAudit(limit = 1000): Promise<AuditEvent[]> { return this.audit.slice(-limit).map(clone); }
  async getIdempotent(key: string, actorId: string): Promise<{ requestHash: string; response: unknown } | null> { const v = this.idem.get(key + '|' + actorId); return v ? clone(v) : null; }
  async putIdempotent(key: string, actorId: string, requestHash: string, response: unknown, at: number): Promise<void> { this.idem.set(key + '|' + actorId, { requestHash, response: clone(response) }); this.idemAt.set(key + '|' + actorId, at); }
  async close(): Promise<void> { /* nada */ }
}
