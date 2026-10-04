/** Convites por cadeira (mesa v3) — consumo atômico, revogação, expiração, unicidade por cadeira. */
import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';
import { SqlStore, createPgliteClient } from '../src/db/sqlStore.js';
import type { MesaInviteRow, Store } from '../src/db/repository.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const row = (over: Partial<MesaInviteRow> = {}): MesaInviteRow => ({
  inviteId: 'inv_' + Math.random().toString(36).slice(2, 10), mesaId: 'mesa_A', chairId: 'chair_seller',
  codeHash: 'h'.repeat(64), codePrefix: 'AB23', status: 'PENDING',
  usedByAddress: null, usedByName: null, usedAt: null, createdAt: NOW, expiresAt: NOW + 3600_000, ...over,
});

function suite(name: string, make: () => Promise<Store>): void {
  describe(`mesa_invites — ${name}`, () => {
    it('consumo atômico: duas tentativas simultâneas → exatamente uma vence', async () => {
      const store = await make();
      const inv = row();
      await store.insertMesaInvite(inv);
      const [a, b] = await Promise.all([
        store.consumeMesaInvite(inv.inviteId, { address: 'walletA', name: 'Ana' }, NOW + 1000),
        store.consumeMesaInvite(inv.inviteId, { address: 'walletB', name: 'Beto' }, NOW + 1000),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const after = await store.getMesaInvite(inv.inviteId);
      expect(after?.status).toBe('USED');
      expect(['walletA', 'walletB']).toContain(after?.usedByAddress);
      // segunda rodada nunca vence
      expect(await store.consumeMesaInvite(inv.inviteId, { address: 'walletC', name: 'Caio' }, NOW + 2000)).toBe(false);
      await store.close();
    });

    it('convite expirado não é consumível', async () => {
      const store = await make();
      const inv = row({ expiresAt: NOW - 1 });
      await store.insertMesaInvite(inv);
      expect(await store.consumeMesaInvite(inv.inviteId, { address: 'w', name: 'N' }, NOW)).toBe(false);
      await store.close();
    });

    it('revogação só atinge convite PENDING da própria mesa', async () => {
      const store = await make();
      const inv = row();
      await store.insertMesaInvite(inv);
      expect(await store.revokeMesaInvite(inv.inviteId, 'mesa_OUTRA')).toBe(false);
      expect(await store.revokeMesaInvite(inv.inviteId, inv.mesaId)).toBe(true);
      expect((await store.getMesaInvite(inv.inviteId))?.status).toBe('REVOKED');
      expect(await store.consumeMesaInvite(inv.inviteId, { address: 'w', name: 'N' }, NOW)).toBe(false);
      await store.close();
    });

    it('no máximo um convite PENDING por cadeira; listagem filtra por mesa', async () => {
      const store = await make();
      const a = row({ mesaId: 'mesa_A', chairId: 'c1' });
      await store.insertMesaInvite(a);
      await expect(store.insertMesaInvite(row({ mesaId: 'mesa_A', chairId: 'c1' }))).rejects.toBeTruthy();
      await store.insertMesaInvite(row({ mesaId: 'mesa_B', chairId: 'c1' })); // outra mesa pode
      expect(await store.listMesaInvites('mesa_A')).toHaveLength(1);
      expect(await store.listMesaInvites('mesa_B')).toHaveLength(1);
      await store.close();
    });
  });
}

suite('MemoryStore', async () => new MemoryStore());
suite('SqlStore (PGlite)', async () => { const c = await createPgliteClient(); const s = new SqlStore(c); await s.init(); return s; });
