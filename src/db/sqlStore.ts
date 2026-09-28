/**
 * Store SQL sobre um cliente mínimo (PGlite em dev/teste; node-postgres em produção via a mesma interface `query`).
 * O schema vive em db/migrations. Lock otimista via `WHERE version = $expected`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AuditEvent, Deal, DealEvent, RiskEvent, SettlementRecord, SignatureRecord } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import type { NonceRow, Store } from './repository.js';

export interface SqlClient { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; /** Executa script com múltiplas instruções (migrações). */ exec?(sql: string): Promise<void>; close?(): Promise<void> }

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../db/migrations');
export const MIGRATION_PATH = path.resolve(MIGRATIONS_DIR, '001_init.sql');
const parseDoc = <T>(doc: unknown): T => (typeof doc === 'string' ? JSON.parse(doc) : doc) as T;

export class SqlStore implements Store {
  constructor(private readonly sql: SqlClient) {}
  /** Aplica todas as migrações em ordem (idempotentes: IF NOT EXISTS / OR REPLACE). */
  async init(): Promise<void> { for (const f of readdirSync(MIGRATIONS_DIR).filter(x => x.endsWith('.sql')).sort()) { const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'); if (this.sql.exec) await this.sql.exec(sql); else await this.sql.query(sql); } }
  async insertDeal(d: Deal): Promise<void> {
    await this.sql.query('INSERT INTO deals (id, version, state, revision, deal_hash, created_by, share_token, expires_at, updated_at, doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [d.id, d.version, d.state, d.revision, d.hash?.dealHash ?? null, d.createdBy, d.shareToken, d.expiresAt, d.updatedAt, JSON.stringify(d)]);
  }
  async getDeal(id: string): Promise<Deal | null> { const r = await this.sql.query<{ doc: unknown }>('SELECT doc FROM deals WHERE id = $1', [id]); const x = r.rows[0]; return x ? parseDoc<Deal>(x.doc) : null; }
  async getDealByShareToken(token: string): Promise<Deal | null> { const r = await this.sql.query<{ doc: unknown }>('SELECT doc FROM deals WHERE share_token = $1', [token]); const x = r.rows[0]; return x ? parseDoc<Deal>(x.doc) : null; }
  async saveDeal(d: Deal, expectedVersion: number): Promise<void> {
    const next = { ...d, version: expectedVersion + 1 };
    const r = await this.sql.query('UPDATE deals SET version=$2, state=$3, revision=$4, deal_hash=$5, expires_at=$6, updated_at=$7, doc=$8 WHERE id=$1 AND version=$9 RETURNING id', [d.id, next.version, d.state, d.revision, d.hash?.dealHash ?? null, d.expiresAt, d.updatedAt, JSON.stringify(next), expectedVersion]);
    if (r.rows.length === 0) throw new DomainError('VERSION_CONFLICT', 'Deal modificada concorrentemente', { expected: expectedVersion });
  }
  /** Filtros empurrados para o SQL (índice deals_state_expires + GIN em doc->'participants'); nunca carrega a tabela inteira. */
  async listDeals(filter?: { states?: string[]; participant?: string }): Promise<Deal[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (filter?.states) { params.push(filter.states); where.push(`state = ANY($${params.length}::text[])`); }
    if (filter?.participant) { params.push(JSON.stringify([{ address: filter.participant }])); where.push(`(doc->'participants') @> $${params.length}::jsonb`); }
    const r = await this.sql.query<{ doc: unknown }>(`SELECT doc FROM deals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 5000`, params);
    return r.rows.map(x => parseDoc<Deal>(x.doc));
  }
  async appendDealEvent(ev: DealEvent): Promise<void> { await this.sql.query('INSERT INTO deal_events (deal_id, seq, type, at, actor, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [ev.dealId, ev.seq, ev.type, ev.at, ev.actor, JSON.stringify(ev.payload), ev.prevHash, ev.hash]); }
  private mapEvent(x: Record<string, unknown>): DealEvent { return { dealId: x.deal_id as string, seq: Number(x.seq), type: x.type as string, at: Number(x.at), actor: x.actor as string, payload: parseDoc<Record<string, unknown>>(x.payload), prevHash: x.prev_hash as string, hash: x.hash as string }; }
  async listDealEvents(dealId: string): Promise<DealEvent[]> { const r = await this.sql.query<Record<string, unknown>>('SELECT * FROM deal_events WHERE deal_id=$1 ORDER BY seq', [dealId]); return r.rows.map(x => this.mapEvent(x)); }
  async lastDealEvent(dealId: string): Promise<DealEvent | null> { const r = await this.sql.query<Record<string, unknown>>('SELECT * FROM deal_events WHERE deal_id=$1 ORDER BY seq DESC LIMIT 1', [dealId]); const x = r.rows[0]; return x ? this.mapEvent(x) : null; }
  async insertSignature(s: SignatureRecord): Promise<void> {
    try { await this.sql.query('INSERT INTO signatures (id, deal_id, revision, role, signer, scheme, signed_hash, nonce, status, received_at, doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [s.id, s.dealId, s.revision, s.role, s.signer, s.scheme, s.signedHash, s.nonce, s.status, s.receivedAt, JSON.stringify(s)]); }
    catch (e) { throw new DomainError('VERSION_CONFLICT', 'assinatura válida duplicada', { cause: String(e) }); }
  }
  async updateSignatureStatus(id: string, status: SignatureRecord['status']): Promise<void> { await this.sql.query(`UPDATE signatures SET status=$2, doc = jsonb_set(doc, '{status}', to_jsonb($2::text)) WHERE id=$1`, [id, status]); }
  async listSignatures(dealId: string, revision?: number): Promise<SignatureRecord[]> { const r = await this.sql.query<{ doc: unknown }>('SELECT doc FROM signatures WHERE deal_id=$1 AND ($2::int IS NULL OR revision=$2) ORDER BY received_at', [dealId, revision ?? null]); return r.rows.map(x => parseDoc<SignatureRecord>(x.doc)); }
  async insertNonce(n: NonceRow): Promise<void> { await this.sql.query('INSERT INTO nonces (value, kind, deal_id, revision, role, subject, issued_at, expires_at, consumed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [n.value, n.kind, n.dealId, n.revision, n.role, n.subject, n.issuedAt, n.expiresAt, n.consumedAt]); }
  private mapNonce(x: Record<string, unknown>): NonceRow { return { value: x.value as string, kind: x.kind as NonceRow['kind'], dealId: (x.deal_id as string | null) ?? null, revision: x.revision === null || x.revision === undefined ? null : Number(x.revision), role: (x.role as string | null) ?? null, subject: (x.subject as string | null) ?? null, issuedAt: Number(x.issued_at), expiresAt: Number(x.expires_at), consumedAt: x.consumed_at === null || x.consumed_at === undefined ? null : Number(x.consumed_at) }; }
  async getNonce(value: string): Promise<NonceRow | null> { const r = await this.sql.query<Record<string, unknown>>('SELECT * FROM nonces WHERE value=$1', [value]); const x = r.rows[0]; return x ? this.mapNonce(x) : null; }
  async findOpenNonce(dealId: string, revision: number, role: string, now: number): Promise<NonceRow | null> { const r = await this.sql.query<Record<string, unknown>>("SELECT * FROM nonces WHERE kind='approval' AND deal_id=$1 AND revision=$2 AND role=$3 AND consumed_at IS NULL AND expires_at > $4 ORDER BY issued_at DESC LIMIT 1", [dealId, revision, role, now]); const x = r.rows[0]; return x ? this.mapNonce(x) : null; }
  async purge(now: number, idempotencyTtlMs: number): Promise<{ nonces: number; idempotency: number }> { const a = await this.sql.query('DELETE FROM nonces WHERE expires_at <= $1 RETURNING value', [now]); const b = await this.sql.query('DELETE FROM idempotency_keys WHERE created_at <= $1 RETURNING key', [now - idempotencyTtlMs]); return { nonces: a.rows.length, idempotency: b.rows.length }; }
  async consumeNonce(value: string, at: number): Promise<boolean> { const r = await this.sql.query('UPDATE nonces SET consumed_at=$2 WHERE value=$1 AND consumed_at IS NULL RETURNING value', [value, at]); return r.rows.length === 1; }
  async insertSettlement(s: SettlementRecord): Promise<boolean> { const r = await this.sql.query('INSERT INTO settlements (deal_id, revision, lock_token, status, started_at, doc) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (deal_id) DO NOTHING RETURNING deal_id', [s.dealId, s.revision, s.lockToken, s.status, s.startedAt, JSON.stringify(s)]); return r.rows.length === 1; }
  async updateSettlement(s: SettlementRecord): Promise<void> { await this.sql.query('UPDATE settlements SET status=$2, doc=$3 WHERE deal_id=$1', [s.dealId, s.status, JSON.stringify(s)]); }
  async getSettlement(dealId: string): Promise<SettlementRecord | null> { const r = await this.sql.query<{ doc: unknown }>('SELECT doc FROM settlements WHERE deal_id=$1', [dealId]); const x = r.rows[0]; return x ? parseDoc<SettlementRecord>(x.doc) : null; }
  async insertRiskEvent(e: RiskEvent): Promise<void> { await this.sql.query('INSERT INTO risk_events (id, deal_id, wallet, rule, severity, decision, at, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [e.id, e.dealId, e.wallet, e.rule, e.severity, e.decision, e.at, JSON.stringify(e.evidence)]); }
  async listRiskEvents(dealId: string): Promise<RiskEvent[]> { const r = await this.sql.query<Record<string, unknown>>('SELECT * FROM risk_events WHERE deal_id=$1 ORDER BY at', [dealId]); return r.rows.map(x => ({ id: x.id as string, dealId: x.deal_id as string, wallet: (x.wallet as string | null) ?? null, rule: x.rule as string, severity: x.severity as RiskEvent['severity'], decision: x.decision as RiskEvent['decision'], at: Number(x.at), evidence: parseDoc<Record<string, unknown>>(x.evidence) })); }
  async appendAudit(a: AuditEvent): Promise<void> { await this.sql.query('INSERT INTO audit_events (seq, at, actor_type, actor_id, category, deal_id, payload_hash, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [a.seq, a.at, a.actorType, a.actorId, a.category, a.dealId, a.payloadHash, JSON.stringify(a.payload), a.prevHash, a.hash]); }
  private mapAudit(x: Record<string, unknown>): AuditEvent { return { seq: Number(x.seq), at: Number(x.at), actorType: x.actor_type as AuditEvent['actorType'], actorId: x.actor_id as string, category: x.category as string, dealId: (x.deal_id as string | null) ?? null, payloadHash: x.payload_hash as string, payload: parseDoc<Record<string, unknown>>(x.payload), prevHash: x.prev_hash as string, hash: x.hash as string }; }
  async lastAudit(): Promise<AuditEvent | null> { const r = await this.sql.query<Record<string, unknown>>('SELECT * FROM audit_events ORDER BY seq DESC LIMIT 1'); const x = r.rows[0]; return x ? this.mapAudit(x) : null; }
  async listAudit(limit = 1000): Promise<AuditEvent[]> { const r = await this.sql.query<Record<string, unknown>>('SELECT * FROM audit_events ORDER BY seq DESC LIMIT $1', [limit]); return r.rows.map(x => this.mapAudit(x)).reverse(); }
  async getIdempotent(key: string, actorId: string): Promise<{ requestHash: string; response: unknown } | null> { const r = await this.sql.query<Record<string, unknown>>('SELECT request_hash, response FROM idempotency_keys WHERE key=$1 AND actor_id=$2', [key, actorId]); const x = r.rows[0]; return x ? { requestHash: x.request_hash as string, response: parseDoc<unknown>(x.response) } : null; }
  async putIdempotent(key: string, actorId: string, requestHash: string, response: unknown, at: number): Promise<void> { await this.sql.query('INSERT INTO idempotency_keys (key, actor_id, request_hash, response, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [key, actorId, requestHash, JSON.stringify(response), at]); }
  async close(): Promise<void> { await this.sql.close?.(); }
}

/** Cliente PGlite (PostgreSQL em WASM) — desenvolvimento e testes. Em produção: mesma interface sobre node-postgres. */
export async function createPgliteClient(dataDir?: string): Promise<SqlClient> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> { const r = await db.query<T>(sql, params); return { rows: r.rows }; },
    async exec(sql: string): Promise<void> { await db.exec(sql); },
    async close(): Promise<void> { await db.close(); }
  };
}
