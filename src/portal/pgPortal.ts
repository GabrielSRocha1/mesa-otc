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
    // Upsert do documento inteiro. Fire-and-forget rastreado por `pending` (aguardado em flush()).
    const doc = JSON.stringify(data);
    const at = this.now();
    this.pending = this.sql
      .query('INSERT INTO portal_state (id, doc, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO UPDATE SET doc = $2::jsonb, updated_at = $3', [ID, doc, at])
      .catch(e => { logger.error({ err: (e as Error).message }, 'portal save falhou'); });
  }

  async flush(): Promise<void> { await this.pending; }
}
