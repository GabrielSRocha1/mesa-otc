/**
 * Ciclo COMPLETO (motor + simulador local) do modo v3 — comprador EXTERNO paga BTC:
 * a comissão dos PMs é custodiada na perna do VENDEDOR (USDT na EVM), o settle paga os PMs em
 * USDT na mesma liquidação atômica, a perna BTC do comprador é o valor CHEIO com deságio, e o
 * refund devolve principal + comissões ao Vendedor. Paridade com o VerumOTCEscrowV2 v3.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, prepareDeal, fullySign, evmWallet, btcWallet, type Parts } from './helpers.js';
import { ASSETS } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';
import { commissionInSellerAsset } from '../src/onchain/core/fee.js';

const AMOUNT_IN = 10_000_000_000n; // 10.000 USDT (6 dec)
const D = 200; // deságio 2%
const C = 100; // comissão 1%

describe('v3 — comprador paga BTC: comissão custodiada e paga na perna do Vendedor (USDT)', () => {
  it('settle atômico: PMs recebem o split em USDT, comprador leva o principal, perna BTC é CHEIA', async () => {
    const { app } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: evmWallet(), BUYER: btcWallet(), PAYMASTER_1: evmWallet(), PAYMASTER_2: evmWallet() };
    const d = await prepareDeal(app, parts, {
      assetIn: ASSETS.USDT_ETH, assetOut: ASSETS.BTC, amountInBase: AMOUNT_IN.toString(),
      discountBps: D, commissionBps: C, commissionSplitBps: [60, 40],
    });
    const t0 = (await app.deals.get(d.id)).terms!;
    // Pricing congelado marca o modo v3 e a perna do comprador NÃO é debitada de nada.
    expect(t0.pricing.commissionLeg).toBe('SELLER');
    expect(t0.route.kind).toBe('HTLC');
    expect(t0.pricing.netAmountSellerBase).toBe(t0.legs[1]!.amountBase); // saída INTEIRA ao vendedor

    const usdt = LOCAL_TOKENS.usdtEth;
    const total = commissionInSellerAsset(AMOUNT_IN, D, C); // 10.000 × 0,98 × 1% = 98 USDT
    expect(total).toBe(98_000_000n);
    const pm2 = total * 40n / BigInt(C);
    const pm1 = total - pm2;

    await fullySign(app, d.id, parts);
    // Vendedor depositou principal + comissões (custodiadas); o escrow EVM segura tudo até o settle.
    expect(app.local!.evm.balanceOf(parts.SELLER.address, usdt)).toBe(AMOUNT_IN * 2n - AMOUNT_IN - total);

    expect((await app.settlement.settle(d.id)).status).toBe('DONE');
    expect((await app.deals.get(d.id)).state).toBe('SETTLED');

    // UMA liquidação: principal ao comprador, split exato aos PMs em USDT, escrow EVM zera.
    expect(app.local!.evm.balanceOf(parts.BUYER.address, usdt)).toBe(AMOUNT_IN);
    expect(app.local!.evm.balanceOf(parts.PAYMASTER_1.address, usdt)).toBe(pm1);
    expect(app.local!.evm.balanceOf(parts.PAYMASTER_2!.address, usdt)).toBe(pm2);
    expect(app.local!.evm.balanceOf('0xEsCr0w00000000000000000000000000000000Aa', usdt)).toBe(0n);

    // Perna BTC: o comprador trancou o valor CHEIO com deságio e o vendedor o recebeu (− fee da leg).
    const outSats = BigInt(t0.legs[1]!.amountBase);
    const btcFee = outSats * BigInt(t0.pricing.platformFeeBps) / 10000n;
    expect(app.local!.bitcoin.balanceOf(parts.SELLER.address, null)).toBe(outSats - btcFee);
    await app.close();
  });

  it('refund pós-expiração devolve principal + comissões ao VENDEDOR (nada fica no escrow)', async () => {
    const { app, clock } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: evmWallet(), BUYER: btcWallet(), PAYMASTER_1: evmWallet() };
    const d = await prepareDeal(app, parts, {
      assetIn: ASSETS.USDT_ETH, assetOut: ASSETS.BTC, amountInBase: AMOUNT_IN.toString(),
      discountBps: D, commissionBps: C, expiresInSec: 1800,
    });
    await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    const t = (await app.deals.get(d.id)).terms!;
    const sellerLeg = t.legs[0]!.index;
    const usdt = LOCAL_TOKENS.usdtEth;
    const total = commissionInSellerAsset(AMOUNT_IN, D, C);
    expect(app.local!.evm.balanceOf(parts.SELLER.address, usdt)).toBe(AMOUNT_IN * 2n - AMOUNT_IN - total);

    clock.advance(2 * 3600_000); // vence a janela on-chain
    await app.local!.evm.refund(d.id, sellerLeg);
    expect(app.local!.evm.balanceOf(parts.SELLER.address, usdt)).toBe(AMOUNT_IN * 2n); // voltou TUDO
    expect(app.local!.evm.balanceOf(parts.PAYMASTER_1.address, usdt)).toBe(0n);
    await app.close();
  });
});
