/**
 * Fase 4b (mesa) — approve cria a operação LIGHTNING_SWAP das cadeiras: Vendedor = BTC via Lightning
 * (tesouraria), Comprador = token (USDT) + fornece a invoice pela API. Prova o endpoint da invoice,
 * o precheck de liquidez e a criação da deal LIGHTNING_SWAP.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeApp, evmWallet } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';
import { LightningSimulator } from '../src/adapters/lightning/simulator.js';
import type { MesaChair } from '../src/mesa/types.js';

const pmHeaders = (t: string) => ({ authorization: `Bearer ${t}` });
const uniqueEmail = () => `ln-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;
const fundedReaders = { native: async () => ({ amount: 50 }), tokens: async () => [{ symbol: 'USDT', contract: LOCAL_TOKENS.usdtEth, amount: 10_000_000 }], priceUsdOf: async () => 1_000 };
const multichain = (primary: { network: string; address: string }, extra: { network: string; address: string }[]) => ({ address: primary.address, network: primary.network, multichain: true, connectedAt: Date.now(), addresses: [primary, ...extra] });

describe('mesa — LIGHTNING_SWAP (BTC via Lightning ↔ USDT)', () => {
  it('comprador informa a invoice → approve cria a deal LIGHTNING_SWAP', async () => {
    const ln = new LightningSimulator(1_000_000n);
    const R = bytesToHex(randomBytes(32)); const H = ln.seedPreimage(R);
    const amountSat = 20_000n;
    const inv = await ln.addInvoice(H, amountSat, 'mesa-ln');

    const { app } = await makeApp({ balanceReaders: fundedReaders, lightning: ln });
    const reg = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } });
    const token = reg.json<{ token: string }>().token;
    const mesaRes = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { chairs: [
      { role: 'SELLER', expectedAsset: { network: 'lightning', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'ethereum', contractOrMint: LOCAL_TOKENS.usdtEth, decimals: 6, symbol: 'tUSDT' } },
      { role: 'PAYMASTER_1', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
    ] } });
    expect(mesaRes.statusCode, mesaRes.body).toBe(201);
    const { mesaId } = mesaRes.json<{ mesaId: string }>();

    const sellerEvm = evmWallet(); const buyer = evmWallet(); const pm1 = evmWallet();
    const mesa = app.mesa.mesaById(mesaId)!;
    const chairOf = (role: string): MesaChair => mesa.chairs.find(c => c.role === role) as MesaChair;
    // Vendedor = tesouraria (endereço EVM recebe o USDT); Comprador EVM; PM1 EVM.
    chairOf('SELLER').wallet = multichain({ network: 'ethereum', address: sellerEvm.address }, []) as never;
    chairOf('BUYER').wallet = multichain({ network: 'ethereum', address: buyer.address }, []) as never;
    chairOf('PAYMASTER_1').wallet = multichain({ network: 'ethereum', address: pm1.address }, []) as never;
    mesa.chairs.forEach(c => { c.firstName = c.role; c.connectedAt = Date.now(); });
    app.local!.evm.mint(buyer.address, LOCAL_TOKENS.usdtEth, 10n ** 12n);

    const cfg = await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaId}/config`, headers: pmHeaders(token), payload: { amountInBase: amountSat.toString(), discountBps: 0, commissionBps: 0 } });
    expect(cfg.statusCode, cfg.body).toBe(200);

    // O COMPRADOR informa a invoice (sessão de participante). Emitimos um token de participante via reenter.
    const ch = await app.mesa.reenterChallenge(mesaId, { network: 'ethereum', address: buyer.address, addresses: [{ network: 'ethereum', address: buyer.address }] });
    const re = await app.mesa.reenterMesa(mesaId, { network: 'ethereum', address: buyer.address, nonce: ch.nonce, signature: await buyer.signMessage!(ch.message) });
    const invRes = await app.api.inject({ method: 'POST', url: `/v1/mesas/${mesaId}/lightning-invoice`, headers: { authorization: `Bearer ${re.token}` }, payload: { bolt11: inv.bolt11 } });
    expect(invRes.statusCode, invRes.body).toBe(200);
    expect(invRes.json<{ paymentHash: string }>().paymentHash).toBe(H);

    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: pmHeaders(token), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201);
    const deal = await app.deals.get(ap.json<{ deal: { id: string } }>().deal.id);
    expect(deal.terms?.route.kind).toBe('LIGHTNING_SWAP');
    expect(deal.terms?.route.htlcHash).toBe(H);                       // hashlock = payment_hash da invoice
    expect(deal.lightningInvoice).toBe(inv.bolt11);
    expect(deal.participants.find(p => p.role === 'SELLER')!.fundingRequired).toBe(false);
    expect(app.mesa.mesaById(mesaId)!.dealId).toBe(deal.id);
    await app.close();
  }, 60_000);

  it('liquidez insuficiente → approve bloqueia com mensagem clara', async () => {
    const ln = new LightningSimulator(5_000n);                        // só 5k outbound
    const R = bytesToHex(randomBytes(32)); const H = ln.seedPreimage(R);
    const inv = await ln.addInvoice(H, 20_000n, 'grande');
    const { app } = await makeApp({ balanceReaders: fundedReaders, lightning: ln });
    const reg = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } });
    const token = reg.json<{ token: string }>().token;
    const mesaRes = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { chairs: [
      { role: 'SELLER', expectedAsset: { network: 'lightning', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'ethereum', contractOrMint: LOCAL_TOKENS.usdtEth, decimals: 6, symbol: 'tUSDT' } },
      { role: 'PAYMASTER_1', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
    ] } });
    const { mesaId } = mesaRes.json<{ mesaId: string }>();
    const sellerEvm = evmWallet(); const buyer = evmWallet(); const pm1 = evmWallet();
    const mesa = app.mesa.mesaById(mesaId)!;
    const chairOf = (role: string): MesaChair => mesa.chairs.find(c => c.role === role) as MesaChair;
    chairOf('SELLER').wallet = multichain({ network: 'ethereum', address: sellerEvm.address }, []) as never;
    chairOf('BUYER').wallet = multichain({ network: 'ethereum', address: buyer.address }, []) as never;
    chairOf('PAYMASTER_1').wallet = multichain({ network: 'ethereum', address: pm1.address }, []) as never;
    mesa.chairs.forEach(c => { c.firstName = c.role; c.connectedAt = Date.now(); });
    chairOf('BUYER').lightningInvoice = { bolt11: inv.bolt11, paymentHash: H, amountSat: '20000' };
    app.local!.evm.mint(buyer.address, LOCAL_TOKENS.usdtEth, 10n ** 12n);
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaId}/config`, headers: pmHeaders(token), payload: { amountInBase: '20000', discountBps: 0, commissionBps: 0 } });
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: pmHeaders(token), payload: {} });
    expect(ap.statusCode).toBe(422);                                  // LIQUIDITY_INSUFFICIENT
    expect(ap.body).toMatch(/liquidez/i);
    await app.close();
  }, 60_000);
});
