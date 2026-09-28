/**
 * Porta de persistência. Duas implementações: MemoryStore (testes rápidos) e SqlStore (PGlite/PostgreSQL).
 * Regras impostas aqui e no schema: lock otimista por versão, uma liquidação por Deal, eventos append-only.
 */
import type { AuditEvent, Deal, DealEvent, RiskEvent, SettlementRecord, SignatureRecord } from '../domain/types.js';

export interface NonceRow { value: string; kind: 'challenge' | 'approval'; dealId: string | null; revision: number | null; role: string | null; subject: string | null; issuedAt: number; expiresAt: number; consumedAt: number | null }

export interface Store {
  init(): Promise<void>;
  insertDeal(deal: Deal): Promise<void>;
  getDeal(id: string): Promise<Deal | null>;
  getDealByShareToken(token: string): Promise<Deal | null>;
  /** Salva com lock otimista: falha (VERSION_CONFLICT) se a versão persistida difere de expectedVersion. */
  saveDeal(deal: Deal, expectedVersion: number): Promise<void>;
  listDeals(filter?: { states?: string[]; participant?: string }): Promise<Deal[]>;
  appendDealEvent(ev: DealEvent): Promise<void>;
  listDealEvents(dealId: string): Promise<DealEvent[]>;
  /** Último evento da Deal (O(1) via PK) — evita carregar a linha do tempo inteira a cada escrita. */
  lastDealEvent(dealId: string): Promise<DealEvent | null>;
  insertSignature(sig: SignatureRecord): Promise<void>;
  updateSignatureStatus(id: string, status: SignatureRecord['status']): Promise<void>;
  listSignatures(dealId: string, revision?: number): Promise<SignatureRecord[]>;
  insertNonce(n: NonceRow): Promise<void>;
  getNonce(value: string): Promise<NonceRow | null>;
  consumeNonce(value: string, at: number): Promise<boolean>;
  /** Nonce de aprovação ainda aberto para (deal, revisão, papel) — reutilizado em vez de emitir um novo a cada GET. */
  findOpenNonce(dealId: string, revision: number, role: string, now: number): Promise<NonceRow | null>;
  /** Retenção: remove nonces vencidos e chaves de idempotência antigas. Nunca toca em deals/eventos/auditoria. */
  purge(now: number, idempotencyTtlMs: number): Promise<{ nonces: number; idempotency: number }>;
  /** Retorna false se já existe liquidação para a Deal (unicidade). */
  insertSettlement(s: SettlementRecord): Promise<boolean>;
  updateSettlement(s: SettlementRecord): Promise<void>;
  getSettlement(dealId: string): Promise<SettlementRecord | null>;
  insertRiskEvent(r: RiskEvent): Promise<void>;
  listRiskEvents(dealId: string): Promise<RiskEvent[]>;
  appendAudit(a: AuditEvent): Promise<void>;
  lastAudit(): Promise<AuditEvent | null>;
  listAudit(limit?: number): Promise<AuditEvent[]>;
  getIdempotent(key: string, actorId: string): Promise<{ requestHash: string; response: unknown } | null>;
  putIdempotent(key: string, actorId: string, requestHash: string, response: unknown, at: number): Promise<void>;
  close(): Promise<void>;
}
