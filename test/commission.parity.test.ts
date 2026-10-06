/**
 * Paridade do SIMULADOR com a comissão on-chain do VerumOTCEscrowV2: o comprador deposita
 * líquido + comissões, o settle paga vendedor + PMs na mesma liquidação atômica, e o refund
 * devolve tudo ao comprador — mesmos números do contrato (split assinado; resto inteiro → PM1).
 */
import { describe, it, expect } from 'vitest';
import { makeApp, prepareDeal, fullySign, solWallet, type Parts } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';

describe('simulador — comissão dos PMs paga on-chain (paridade com o settleV2)', () => {
  it('settle paga líquido ao vendedor e o split exato aos PMs; comprador debita líquido + comissão', async () => {
    const { app } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet(), PAYMASTER_2: solWallet() };
    const d = await prepareDeal(app, parts, { amountInBase: '250000000000', discountBps: 300, commissionBps: 200, commissionSplitBps: [150, 50] });
    await fullySign(app, d.id, parts);
    expect((await app.settlement.settle(d.id)).status).toBe('DONE');

    const t = (await app.deals.get(d.id)).terms!;
    const out = BigInt(t.legs[1]!.amountBase);
    const fee = out * BigInt(t.pricing.platformFeeBps) / 10000n;
    const total = out * 200n / (10000n - 300n - 200n); // out·c/(1−d−c), como no contrato
    const pm2 = total * 50n / 200n;
    const pm1 = total - pm2; // resto da divisão inteira fica com o PM1
    const usdc = LOCAL_TOKENS.usdcSol;

    expect(app.local!.solana.balanceOf(parts.PAYMASTER_1.address, usdc)).toBe(pm1);
    expect(app.local!.solana.balanceOf(parts.PAYMASTER_2!.address, usdc)).toBe(pm2);
    expect(app.local!.solana.balanceOf(parts.SELLER.address, usdc)).toBe(out - fee);
    expect(app.local!.solana.balanceOf(parts.BUYER.address, usdc)).toBe(10n ** 15n - out - total); // líquido + comissões debitados
    expect(app.local!.solana.balanceOf('VerumEscrow11111111111111111111111111111111', usdc)).toBe(0n); // escrow zera
    await app.close();
  });

  it('refund devolve principal + comissões ao comprador (comissão não paga nunca fica no escrow)', async () => {
    const { app, clock } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts, { amountInBase: '250000000000', discountBps: 300, commissionBps: 200, expiresInSec: 1800 });
    await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
    const t = (await app.deals.get(d.id)).terms!;
    const out = BigInt(t.legs[1]!.amountBase);
    const buyerLeg = t.legs[1]!.index;
    const usdc = LOCAL_TOKENS.usdcSol;
    expect(app.local!.solana.balanceOf(parts.BUYER.address, usdc)).toBeLessThan(10n ** 15n - out); // depositou líquido + comissão

    clock.advance(2 * 3600_000); // vence a janela on-chain
    await app.local!.solana.refund(d.id, buyerLeg);
    expect(app.local!.solana.balanceOf(parts.BUYER.address, usdc)).toBe(10n ** 15n); // voltou TUDO
    await app.close();
  });
});
