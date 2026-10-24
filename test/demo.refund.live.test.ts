/**
 * DEMO narrado (tempo real, HTTP real via inject + cron de produção): operação NORMAL (FIXED)
 * financiada → janela expira → o cron /ops/cron/sweep reembolsa SOZINHO → saldos voltam.
 * Mesmo código/rotas do deploy; só as cadeias são simuladas (pra poder financiar sem chaves de testnet).
 */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, type Wallet } from './helpers.js';
import type { App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';

const SOL = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
const USDC = { network: 'solana', contractOrMint: 'USDC1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC' };
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const readers: BalanceReaders = { native: async () => ({ amount: 1000 }), tokens: async () => [{ symbol: 'USDC', contract: USDC.contractOrMint, amount: 10 ** 9 }], priceUsdOf: async () => 150 };
const log = (...a: unknown[]) => console.log(...a);

async function join(app: App, pm: string, mesaId: string, chairId: string, name: string, w: Wallet) {
  const inv = (await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${chairId}/invite`, headers: H(pm) })).json<{ inviteId: string; code: string }>();
  const ch = (await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${inv.inviteId}/challenge`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address } })).json<{ message: string; nonce: string }>();
  const j = await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${inv.inviteId}/join`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), addresses: [{ network: 'solana', address: w.address }] } });
  expect(j.statusCode).toBe(201);
}

describe('DEMO AO VIVO · reembolso de operação normal', () => {
  it('financiada → expira → cron reembolsa sozinho → saldos voltam', async () => {
    process.env.CRON_SECRET = 'demo-cron-secret';
    const { app, clock } = await makeApp({ balanceReaders: readers, autoSettle: false });
    const sol = app.adapters.require('solana');
    type CanonAsset = Parameters<typeof sol.getBalance>[1];
    const bal = async (addr: string, asset: CanonAsset) => (await sol.getBalance(addr, asset)).toString();

    log('\n╔═══════════════════════════════════════════════════════════╗');
    log('║  DEMO: reembolso de operação NORMAL (FIXED) em tempo real ║');
    log('╚═══════════════════════════════════════════════════════════╝');

    // 1) Pay Master
    const pm = (await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM Demo', email: `demo-${Date.now()}@verum.test`, password: 'senha-forte-1' } })).json<{ token: string }>().token;
    const pmW = solWallet();
    await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: H(pm), payload: { address: pmW.address, network: 'solana' } });
    log('\n[1] Pay Master registrado e carteira conectada.');

    // 2) Mesa SOL (Vendedor) ↔ USDC (Comprador)
    const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: H(pm), payload: { network: 'solana', chairs: [
      { role: 'SELLER', expectedAsset: SOL }, { role: 'BUYER', expectedAsset: USDC }, { role: 'PAYMASTER_1', expectedAsset: SOL },
    ] } })).json<{ mesaId: string; code: string; chairs: { chairId: string; role: string }[] }>();
    const chair = (r: string) => mesa.chairs.find(c => c.role === r)!.chairId;
    const seller = solWallet(), buyer = solWallet();
    await join(app, pm, mesa.mesaId, chair('SELLER'), 'Vendedor', seller);
    await join(app, pm, mesa.mesaId, chair('BUYER'), 'Comprador', buyer);
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesa.mesaId}/config`, headers: H(pm), payload: { amountInBase: '250000000000', discountBps: 0, commissionBps: 0 } });
    log(`[2] Mesa ${mesa.code} criada; Vendedor e Comprador conectados; config salva (250 SOL).`);

    // 3) Aprovar → cria a operação e FINANCIA as duas pernas (simulador)
    // expiresInSec=900 (15 min): no simulador a janela on-chain é essa (o contrato REAL usa 40 min fixos).
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/approve`, headers: H(pm), payload: { expiresInSec: 900 } });
    expect(ap.statusCode, ap.body).toBe(201);
    const dealId = ap.json<{ deal: { id: string } }>().deal.id;
    const d0 = await app.deals.get(dealId);
    const sellerAsset = d0.terms!.legs[0]!.asset, buyerAsset = d0.terms!.legs[1]!.asset; // ativos REAIS das pernas (canônicos)
    const sellerBefore = await bal(seller.address, sellerAsset), buyerBefore = await bal(buyer.address, buyerAsset);
    log('\n[3] APROVADA → operação ' + dealId);
    log('    estado:', d0.state, '| pernas financiadas:', d0.participants.filter(p => p.funding === 'FINAL').map(p => p.role).join(', '));
    log('    saldo APÓS depósito → Vendedor:', sellerBefore, 'lamports SOL | Comprador:', buyerBefore, 'µUSDC');
    const chainBefore = await sol.getDealState(dealId);
    log('    cofre on-chain: status=' + chainBefore.status + ' depósitos=' + Object.keys(chainBefore.deposits).length);

    // 4) Passa o tempo: a janela on-chain (40 min) expira sem assinatura
    log('\n[4] ⏳ Simulando a passagem da janela on-chain sem ninguém assinar (relógio avançado)...');
    clock.advance(16 * 60 * 1000);

    // 5) O CRON de produção roda a varredura (o mesmo /ops/cron/sweep do deploy) — SEM ação humana
    const sweep = await app.api.inject({ method: 'GET', url: '/ops/cron/sweep', headers: { authorization: 'Bearer demo-cron-secret' } });
    log('\n[5] 🤖 Cron /ops/cron/sweep (automático) →', sweep.statusCode, sweep.body);

    // 6) Resultado: operação expirada e REEMBOLSADA, saldos de volta
    const d1 = await app.deals.get(dealId);
    const sellerAfter = await bal(seller.address, sellerAsset), buyerAfter = await bal(buyer.address, buyerAsset);
    const chainAfter = await sol.getDealState(dealId);
    log('\n[6] RESULTADO:');
    log('    estado da operação:', d1.state);
    log('    reembolsos:', d1.refunds.map(r => `${r.role}#${r.legIndex}=${r.status}`).join(', ') || '—');
    log('    saldo APÓS reembolso → Vendedor:', sellerAfter, 'lamports SOL | Comprador:', buyerAfter, 'µUSDC');
    log('    cofre on-chain: status=' + chainAfter.status + ' refundedTx=' + (chainAfter.refundedTx ? '✓' : '—'));
    log('    Vendedor recuperou:', (BigInt(sellerAfter) - BigInt(sellerBefore)).toString(), 'lamports | Comprador recuperou:', (BigInt(buyerAfter) - BigInt(buyerBefore)).toString(), 'µUSDC');
    log('════════════════════════════════════════════════════════════\n');

    expect(['REFUNDING', 'REFUNDED']).toContain(d1.state);
    expect(d1.refunds.filter(r => r.status === 'REFUNDED').length).toBeGreaterThanOrEqual(2);
    expect(BigInt(sellerAfter)).toBeGreaterThan(BigInt(sellerBefore));
    expect(BigInt(buyerAfter)).toBeGreaterThan(BigInt(buyerBefore));
    await app.close();
  }, 120_000);
});
