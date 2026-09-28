import { describe, it, expect } from 'vitest';
import { SqlStore, createPgliteClient } from '../src/db/sqlStore.js';
import { makeApp, solWallet, prepareDeal, fullySign, type Parts } from './helpers.js';
import { AuditLog } from '../src/audit/audit.js';

describe('Database — SqlStore sobre PGlite (PostgreSQL)', () => {
  it('migração, lock otimista, unicidade de liquidação, nonces e trigger append-only', async () => {
    const client = await createPgliteClient(); const store = new SqlStore(client); await store.init();
    const { app } = await makeApp({ store, autoSettle: false }); const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts); expect((await store.getDeal(d.id))?.state).toBe('LIQUIDITY_VERIFIED');
    const stale = await store.getDeal(d.id); const fresh = await store.getDeal(d.id); await store.saveDeal(fresh!, fresh!.version);
    await expect(store.saveDeal(stale!, stale!.version)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await fullySign(app, d.id, parts); const rec = await app.settlement.settle(d.id); expect(rec.status).toBe('DONE');
    expect(await store.insertSettlement({ ...rec, id: 'ST-dup' })).toBe(false); // PK deal_id
    const sigs = await store.listSignatures(d.id, 1); expect(sigs.filter(s => s.status === 'valid')).toHaveLength(3);
    await expect(store.insertSignature({ ...sigs[0]!, id: 'SG-dup' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }); // índice parcial
    expect(await store.consumeNonce(sigs[0]!.nonce, Date.now())).toBe(false); // já consumido
    const evs = await store.listAudit(); expect(AuditLog.verify(evs).ok).toBe(true);
    await expect(client.query('UPDATE audit_events SET payload = $1 WHERE seq = 1', ['{}'])).rejects.toThrow(/append-only/);
    await expect(client.query('DELETE FROM deal_events WHERE deal_id = $1', [d.id])).rejects.toThrow(/append-only/);
    await app.close();
  }, 120_000);
});
