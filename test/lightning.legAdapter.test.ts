/**
 * Fase 4b — LightningLegAdapter: a perna BTC como SettlementAdapter. registerDeal valida a invoice do
 * Comprador (payment_hash==htlcHash); settle paga e revela R; getDealState/revealedPreimage refletem.
 * Invoice errada → recusa. deposit → recusa (a perna não é depositada, é entregue no settle).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { LightningLegAdapter } from '../src/adapters/lightning/legAdapter.js';
import { LightningSimulator } from '../src/adapters/lightning/simulator.js';
import type { DealCommitment } from '../src/adapters/types.js';

const pre = () => bytesToHex(randomBytes(32));
const hashOf = (p: string) => bytesToHex(sha256(hexToBytes(p)));
const commit = (dealId: string, htlcHash: string) => ({ dealId, htlcHash } as unknown as DealCommitment);

describe('LightningLegAdapter', () => {
  it('registerDeal valida a invoice; settle paga e revela R; idempotente', async () => {
    const R = pre(); const H = hashOf(R);
    const ln = new LightningSimulator(1_000_000n); ln.seedPreimage(R);
    const inv = await ln.addInvoice(H, 20_000n, 'swap');
    const deal = { lightningInvoice: inv.bolt11, terms: { route: { htlcHash: H } } };
    const adapter = new LightningLegAdapter(ln, { getDeal: async () => deal });

    const reg = await adapter.registerDeal(commit('deal-1', H));
    expect(reg.meta?.bolt11).toBe(inv.bolt11);
    expect((await adapter.getDealState('deal-1')).status).toBe('FUNDED'); // pronta p/ liquidar
    expect(await adapter.getBalance()).toBe(1_000_000n);

    const tx = await adapter.settle('deal-1', 0, [], undefined);
    expect(tx.ref).toMatch(/^ln-paid:/);
    expect(await adapter.revealedPreimage('deal-1')).toBe(R);           // R disponível p/ o settleV2
    expect((await adapter.getDealState('deal-1')).status).toBe('SETTLED');
    expect((await ln.getBalance()).outboundSat).toBe(980_000n);

    const tx2 = await adapter.settle('deal-1', 0, [], undefined);       // 2ª vez: idempotente
    expect(tx2.ref).toBe(tx.ref);
  });

  it('invoice que não casa com o htlcHash → registerDeal recusa', async () => {
    const H = hashOf(pre()); const Hwrong = hashOf(pre());
    const ln = new LightningSimulator(1_000_000n);
    const inv = await ln.addInvoice(Hwrong, 20_000n, 'errada');        // payment_hash ≠ htlcHash do deal
    const deal = { lightningInvoice: inv.bolt11, terms: { route: { htlcHash: H } } };
    const adapter = new LightningLegAdapter(ln, { getDeal: async () => deal });
    await expect(adapter.registerDeal(commit('deal-2', H))).rejects.toThrow(/não corresponde ao htlcHash/);
  });

  it('deposit é recusado (a perna lightning é entregue no settle, não depositada)', async () => {
    const ln = new LightningSimulator(1n);
    const adapter = new LightningLegAdapter(ln, { getDeal: async () => ({}) });
    await expect(adapter.deposit()).rejects.toThrow(/não é depositada/);
  });
});
