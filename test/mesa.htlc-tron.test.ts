/**
 * Approve da mesa → deal HTLC com a perna de TOKEN na TRON (escrow V2 Tron com
 * hashlock): vendedor BTC nativo, comprador tUSDT TRC-20, endereços MULTICHAIN
 * por perna. Simuladores locais (bitcoin regtest + tron nile) — o guard que
 * recusava `tokenNet !== 'ethereum'` com SETTLEMENT_NOT_ALLOWED caiu.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, btcWallet, tronWallet } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';
import type { MesaChair } from '../src/mesa/types.js';

const pmHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
const uniqueEmail = () => `htlc-tron-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;
/** Readers mockados: o approve valida saldos on-chain — aqui interessa o fluxo. */
const fundedReaders = {
  native: async () => ({ amount: 50 }),
  tokens: async () => [
    { symbol: 'USDT', contract: LOCAL_TOKENS.usdtTron, amount: 10_000_000 },
    { symbol: 'USDT', contract: LOCAL_TOKENS.usdtEth, amount: 10_000_000 },
  ],
  priceUsdOf: async () => 1_000,
};
const multichain = (primary: { network: string; address: string }, extra: { network: string; address: string }[]) =>
  ({ address: primary.address, network: primary.network, multichain: true, connectedAt: Date.now(), addresses: [primary, ...extra] });

describe('mesa v4 — approve cria a deal HTLC com perna Tron (escrow V2 hashlock)', () => {
  it('BTC nativo (vendedor) ↔ tUSDT Tron (comprador): deal criada na rota HTLC, participantes nas redes das pernas', async () => {
    const { app } = await makeApp({ balanceReaders: fundedReaders, tronHashlock: true });
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const mesaRes = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { chairs: [
      { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'tron', contractOrMint: LOCAL_TOKENS.usdtTron, decimals: 6, symbol: 'USDT' } },
      { role: 'PAYMASTER_1', expectedAsset: { network: 'tron', contractOrMint: null, decimals: 6, symbol: 'TRX' } },
    ] } });
    expect(mesaRes.statusCode, mesaRes.body).toBe(201);
    const { mesaId } = mesaRes.json<{ mesaId: string }>();

    // Conecta as cadeiras diretamente (atalho de teste — prova de posse coberta nos testes v3).
    const seller = btcWallet(); const sellerTron = tronWallet(); const buyer = tronWallet(); const pm1 = tronWallet();
    const mesa = app.mesa.mesaById(mesaId)!;
    const chairOf = (role: string): MesaChair => mesa.chairs.find(c => c.role === role) as MesaChair;
    chairOf('SELLER').wallet = multichain({ network: 'bitcoin', address: seller.address }, [{ network: 'tron', address: sellerTron.address }]);
    // Comprador recebe o BTC no claim → precisa de endereço Bitcoin na carteira multichain.
    chairOf('BUYER').wallet = multichain({ network: 'tron', address: buyer.address }, [{ network: 'bitcoin', address: btcWallet().address }]);
    chairOf('PAYMASTER_1').wallet = multichain({ network: 'tron', address: pm1.address }, []);
    mesa.chairs.forEach(c => { c.firstName = c.role; c.connectedAt = Date.now(); });

    // Saldos on-chain nos SIMULADORES (o verify do motor lê o adaptador de verdade).
    app.local!.bitcoin.mint(seller.address, null, 50_000_000n);
    app.local!.tron!.mint(buyer.address, LOCAL_TOKENS.usdtTron, 10n ** 12n);

    const cfg = await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaId}/config`, headers: pmHeaders(token), payload: { amountInBase: '20000000', buyerAmountInBase: '12000000000', discountBps: 0, commissionBps: 0 } });
    expect(cfg.statusCode, cfg.body).toBe(200);

    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: pmHeaders(token), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201);
    const out = ap.json<{ approved: boolean; deal: { id: string } }>();
    expect(out.approved).toBe(true);

    const deal = await app.deals.get(out.deal.id);
    expect(deal.terms?.route.kind).toBe('HTLC');
    expect(deal.terms?.route.htlcHash).toHaveLength(64);
    expect(deal.draft.assetIn.network).toBe('bitcoin');
    expect(deal.draft.assetOut.network).toBe('tron');
    expect(deal.draft.assetOut.contractOrMint).toBe(LOCAL_TOKENS.usdtTron);
    // Participantes nas redes das SUAS pernas, vindos da carteira multichain.
    expect(deal.participants.find(p => p.role === 'SELLER')?.address).toBe(seller.address);
    expect(deal.participants.find(p => p.role === 'BUYER')?.address).toBe(buyer.address);
    expect(deal.participants.find(p => p.role === 'BUYER')?.network).toBe('tron');
    expect(deal.participants.find(p => p.role === 'PAYMASTER_1')?.network).toBe('tron');
    expect(app.mesa.mesaById(mesaId)!.dealId).toBe(deal.id);
    await app.close();
  }, 60_000);

  it('open ADIADO (lock externo pendente): o poll da mesa cura — registra o cofre e abre quando possível', async () => {
    // Incidente 2026-10-27 (BTC↔Tron em produção): o open falhou/ficou adiado no approve e NENHUM
    // poll re-tentava — o Vendedor nunca via o endereço do cofre (htlcVault null). Aqui criamos a
    // deal parada em LIQUIDITY_VERIFIED (sem open) e provamos que o GET da mesa destrava sozinho.
    const { app } = await makeApp({ balanceReaders: fundedReaders, tronHashlock: true });
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const mesaRes = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { chairs: [
      { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'tron', contractOrMint: LOCAL_TOKENS.usdtTron, decimals: 6, symbol: 'USDT' } },
      { role: 'PAYMASTER_1', expectedAsset: { network: 'tron', contractOrMint: null, decimals: 6, symbol: 'TRX' } },
    ] } });
    const { mesaId } = mesaRes.json<{ mesaId: string }>();
    const mesa = app.mesa.mesaById(mesaId)!;
    const seller = btcWallet(); const buyer = tronWallet(); const pm1 = tronWallet();
    app.local!.bitcoin.mint(seller.address, null, 50_000_000n);
    app.local!.tron!.mint(buyer.address, LOCAL_TOKENS.usdtTron, 10n ** 12n);
    const chainId = app.adapters.require('tron').chain.chainId;
    let deal = await app.deals.create({
      assetIn: { network: 'bitcoin', chainId: app.adapters.require('bitcoin').chain.chainId, contractOrMint: null },
      assetOut: { network: 'tron', chainId, contractOrMint: LOCAL_TOKENS.usdtTron },
      amountInBase: '20000000', discountBps: 0, maxSlippageBps: 50, maxPriceDriftBps: 500, expiresInSec: 2400,
      participants: [
        { role: 'SELLER', network: 'bitcoin', chainId: app.adapters.require('bitcoin').chain.chainId, address: seller.address },
        { role: 'PAYMASTER_1', network: 'tron', chainId, address: pm1.address },
        { role: 'BUYER', network: 'tron', chainId, address: buyer.address },
      ],
    }, seller.address);
    for (const p of [{ role: 'PAYMASTER_1', address: pm1.address }, { role: 'BUYER', address: buyer.address }] as const) {
      deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address);
    }
    deal = await app.deals.get(deal.id);
    expect(deal.state).toBe('LIQUIDITY_VERIFIED'); // termos congelados, open NUNCA rodou (cenário do incidente)
    expect(deal.onChain.bitcoin).toBeUndefined();
    app.mesa.attachDeal(mesa, deal.id);

    // Poll do admin (GET /v1/mesas/:id) → healMesaDeal re-tenta o open.
    const poll = await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaId}`, headers: pmHeaders(token) });
    expect(poll.statusCode, poll.body).toBe(200);
    deal = await app.deals.get(deal.id);
    // No simulador o lock auto-confirma → o heal abre de vez; no mundo real a mesma chamada
    // teria persistido o meta do cofre (onChain.bitcoin) e devolvido FUNDING_REQUIRED.
    expect(deal.state).toBe('AWAITING_SIGNATURES');
    expect(deal.onChain.bitcoin?.registered).toBe(true);
    await app.close();
  }, 60_000);

  it('sem hashlock Tron (escrow V1), a criação da mesa segue bloqueada (guard preservado)', async () => {
    const { app } = await makeApp({ balanceReaders: fundedReaders });
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const mesaRes = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { chairs: [
      { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'tron', contractOrMint: LOCAL_TOKENS.usdtTron, decimals: 6, symbol: 'USDT' } },
      { role: 'PAYMASTER_1', expectedAsset: { network: 'tron', contractOrMint: null, decimals: 6, symbol: 'TRX' } },
    ] } });
    expect(mesaRes.statusCode).toBe(400);
    await app.close();
  });
});
