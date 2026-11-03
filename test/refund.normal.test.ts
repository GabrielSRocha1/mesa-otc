/** Reembolso em operação NORMAL (FIXED, mesma rede): cancelar e expirar devolvem os depósitos. */
import { describe, it, expect } from 'vitest';
import { makeApp, prepareDeal, solWallet, ASSETS, type Parts } from './helpers.js';

const fundBoth = async (app: Awaited<ReturnType<typeof makeApp>>['app'], id: string, parts: Parts) => {
  await app.deals.open(id, parts.SELLER.address);
  await app.deals.fund(id, 'SELLER', parts.SELLER.address);
  await app.deals.fund(id, 'BUYER', parts.BUYER.address);
};

describe('Reembolso · operação normal (FIXED)', () => {
  it('cancelar operação financiada devolve os DOIS depósitos (saldos restaurados)', async () => {
    const { app } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts); // SOL (Vendedor) ↔ USDC (Comprador), preço FIXO
    await fundBoth(app, d.id, parts);

    const solAsset = app.registry.resolve(ASSETS.SOL), usdcAsset = app.registry.resolve(ASSETS.USDC_SOL);
    const sol = app.adapters.require('solana');
    const sellerAfterFund = await sol.getBalance(parts.SELLER.address, solAsset);
    const buyerAfterFund = await sol.getBalance(parts.BUYER.address, usdcAsset);

    const funded = await app.deals.get(d.id);
    expect(funded.participants.filter(p => p.funding === 'FINAL').map(p => p.role).sort()).toEqual(['BUYER', 'SELLER']);

    // Um PARTICIPANTE cancela → supersede on-chain + CANCELLED + reembolso das pernas financiadas.
    const after = await app.deals.cancel(d.id, parts.SELLER.address);
    expect(after.state).toBe('CANCELLED');

    const refunds = (await app.deals.get(d.id)).refunds.filter(r => r.status === 'REFUNDED');
    expect(refunds.map(r => r.legIndex).sort()).toEqual([0, 1]); // perna 0 (Vendedor) e perna 1 (Comprador)
    expect(refunds.every(r => !!r.txRef)).toBe(true);

    // Os depósitos voltaram para as carteiras.
    expect(await sol.getBalance(parts.SELLER.address, solAsset)).toBeGreaterThan(sellerAfterFund);
    expect(await sol.getBalance(parts.BUYER.address, usdcAsset)).toBeGreaterThan(buyerAfterFund);

    // Espelho on-chain (sim): o cofre registra o refund.
    const st = await sol.getDealState(d.id);
    expect(st.refundedTx).toBeTruthy();
    await app.close();
  }, 120_000);

  it('expirar operação financiada → REFUNDING → REFUNDED (varredura do scheduler)', async () => {
    const { app, clock } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts);
    await fundBoth(app, d.id, parts);

    clock.advance(10 * 86400 * 1000); // além de qualquer janela de mesa/turno
    const ids = await app.deals.expireDue();
    expect(ids).toContain(d.id);

    const fin = await app.deals.get(d.id);
    expect(['REFUNDING', 'REFUNDED']).toContain(fin.state);
    expect(fin.refunds.filter(r => r.status === 'REFUNDED').length).toBeGreaterThanOrEqual(2);
    await app.close();
  }, 120_000);
});
