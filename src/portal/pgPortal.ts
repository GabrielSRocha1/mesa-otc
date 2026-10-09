/**
 * Persistência do portal em Postgres/Supabase (tabela portal_state, um documento JSONB).
 * Preserva integralmente a lógica do PortalService — troca apenas o meio de armazenamento.
 *
 * No serverless: `hydrate()` é chamado por request (vê escritas de outras instâncias) e `save()`
 * dispara um upsert rastreável cujo `flush()` é aguardado após mutações — a sessão não se perde
 * entre invocações (diferente do arquivo em /tmp, que era por-instância).
 */
import type { SqlClient } from '../db/sqlStore.js';
import type { PortalData, PortalPersistence } from './portal.js';
import { emptyPortalData } from './portal.js';
import { logger } from '../monitoring/metrics.js';

const ID = 'singleton';

export class PostgresPortalPersistence implements PortalPersistence {
  private cache: PortalData | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private lastSaveError: string | null = null;
  constructor(private readonly sql: SqlClient, private readonly now: () => number = () => Date.now()) {}

  /** Boot é assíncrono neste backend — o serviço começa vazio e é hidratado logo após (createApp). */
  initial(): PortalData | null { return this.cache; }

  async hydrate(): Promise<PortalData | null> {
    try {
      const r = await this.sql.query<{ doc: PortalData }>('SELECT doc FROM portal_state WHERE id = $1', [ID]);
      const doc = r.rows[0]?.doc ?? null;
      // `doc` pode vir como objeto (pg/jsonb) ou string (alguns drivers) — normaliza.
      const parsed = typeof doc === 'string' ? (JSON.parse(doc) as PortalData) : doc;
      this.cache = parsed ?? emptyPortalData();
      return this.cache;
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'portal hydrate falhou');
      return null; // mantém o estado atual em memória
    }
  }

  save(data: PortalData): void {
    // Upsert do documento inteiro, GUARDADO POR VERSÃO: só aplica se o `rev` em memória for mais
    // novo que o do banco — uma instância com snapshot velho não sobrescreve escritas de outra
    // (era a causa da "carteira conectada" sumir no multi-instância da Vercel).
    const doc = JSON.stringify(data);
    const at = this.now();
    const rev = data.rev ?? 0;
    this.pending = this.sql
      .query<{ id: string }>("INSERT INTO portal_state (id, doc, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO UPDATE SET doc = $2::jsonb, updated_at = $3 WHERE COALESCE((portal_state.doc->>'rev')::bigint, 0) < $4 RETURNING id", [ID, doc, at, rev])
      .then(r => { this.lastSaveError = null; if (!r.rows.length) logger.warn({ rev }, 'portal save ignorado — banco tem versão mais nova'); })
      .catch(e => { this.lastSaveError = (e as Error).message; logger.error({ err: (e as Error).message }, 'portal save falhou'); });
  }

  async flush(): Promise<void> { await this.pending; }

  /**
   * Diagnóstico (/healthz/portal): roundtrip REAL de escrita+leitura na tabela e resumo do
   * singleton como ele está NO BANCO (não na memória) — expõe erros que o save silencioso engole.
   */
  async health(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { lastSaveError: this.lastSaveError };
    try {
      const at = this.now();
      await this.sql.query('INSERT INTO portal_state (id, doc, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO UPDATE SET doc = $2::jsonb, updated_at = $3', ['healthcheck', JSON.stringify({ at }), at]);
      const back = await this.sql.query<{ doc: { at?: number } }>('SELECT doc FROM portal_state WHERE id = $1', ['healthcheck']);
      const doc = back.rows[0]?.doc;
      const parsed = typeof doc === 'string' ? JSON.parse(doc) as { at?: number } : doc;
      out.roundtrip = parsed?.at === at ? 'ok' : `leitura divergente: ${JSON.stringify(parsed)}`;
    } catch (e) { out.roundtrip = `ERRO: ${(e as Error).message}`; }
    try {
      const r = await this.sql.query<{ doc: PortalData; updated_at: string | number }>('SELECT doc, updated_at FROM portal_state WHERE id = $1', [ID]);
      const row = r.rows[0];
      const d = row ? (typeof row.doc === 'string' ? JSON.parse(row.doc) as PortalData : row.doc) : null;
      out.singleton = d ? {
        updatedAt: Number(row?.updated_at ?? 0), agoMs: this.now() - Number(row?.updated_at ?? 0),
        payMasters: Object.keys(d.payMasters ?? {}).length,
        withWallet: Object.values(d.payMasters ?? {}).filter(p => (p as { wallet?: unknown }).wallet).length,
        sessions: Object.keys(d.sessions ?? {}).length, mesas: Object.keys(d.mesas ?? {}).length,
      } : null;
    } catch (e) { out.singleton = `ERRO: ${(e as Error).message}`; }
    return out;
  }
}
