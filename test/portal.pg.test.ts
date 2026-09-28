/**
 * Persistência do Portal em Postgres (pglite = Postgres real) — prova o cenário serverless:
 * o estado (cadastro/sessão/carteira) sobrevive a uma NOVA instância do serviço, ao contrário
 * do arquivo /tmp por-instância que causava "volta pro login" na Vercel.
 */
import { describe, it, expect } from 'vitest';
import { createPgliteClient, type SqlClient } from '../src/db/sqlStore.js';
import { PortalService } from '../src/portal/portal.js';
import { PostgresPortalPersistence } from '../src/portal/pgPortal.js';

async function freshDb(): Promise<SqlClient> {
  const sql = await createPgliteClient(); // efêmero em memória
  await sql.query('CREATE TABLE IF NOT EXISTS portal_state (id text PRIMARY KEY, doc jsonb NOT NULL, updated_at bigint NOT NULL)');
  return sql;
}
// Simula uma invocação serverless: novo PortalService sobre o MESMO banco, hidratado.
async function newInstance(sql: SqlClient, now: () => number): Promise<PortalService> {
  const svc = new PortalService({ sessionTtlMs: 24 * 3600_000, now, persistence: new PostgresPortalPersistence(sql, now) });
  await svc.hydrate();
  return svc;
}

describe('Portal · persistência Postgres (Supabase)', () => {
  it('cadastro e sessão sobrevivem a uma nova instância (serverless)', async () => {
    const sql = await freshDb();
    const now = () => 1_700_000_000_000;

    // Instância A: registra e persiste.
    const a = await newInstance(sql, now);
    const { token } = a.register({ name: 'Ana Lima', email: 'ana@x.com', password: 'password1' });
    await a.flush();

    // Instância B (nova invocação, mesmo banco): a sessão do token ainda vale → me() funciona.
    const b = await newInstance(sql, now);
    const me = b.me(token);
    expect(me.payMaster.email).toBe('ana@x.com');
    expect(me.payMaster.name).toBe('Ana Lima');

    // Login numa instância C também enxerga a conta persistida por A.
    const c = await newInstance(sql, now);
    const login = c.login({ email: 'ana@x.com', password: 'password1' });
    expect(login.payMaster.email).toBe('ana@x.com');
    await c.flush();
  });

  it('conexão de carteira persiste entre instâncias', async () => {
    const sql = await freshDb();
    const now = () => 1_700_000_000_000;
    const a = await newInstance(sql, now);
    const { token } = a.register({ name: 'Bruno Souza', email: 'b@x.com', password: 'password1' });
    a.connectWallet(token, { address: 'So1WalletAddrXYZ123456', network: 'solana' });
    await a.flush();

    const b = await newInstance(sql, now);
    expect(b.me(token).wallet?.address).toBe('So1WalletAddrXYZ123456');
  });

  it('e-mail duplicado é rejeitado mesmo após persistir/rehidratar', async () => {
    const sql = await freshDb();
    const now = () => 1_700_000_000_000;
    const a = await newInstance(sql, now);
    a.register({ name: 'Dup Um', email: 'dup@x.com', password: 'password1' });
    await a.flush();
    const b = await newInstance(sql, now);
    expect(() => b.register({ name: 'Dup Dois', email: 'dup@x.com', password: 'password2' })).toThrow(/já cadastrado/);
  });
});
