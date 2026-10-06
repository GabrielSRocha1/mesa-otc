/**
 * Approve da mesa → deal HTLC REAL a partir das cadeiras (v4): vendedor BTC nativo, comprador
 * token na perna EVM, endereços MULTICHAIN por perna. Simuladores locais (bitcoin regtest + evm).
 */
import { describe, it, expect } from 'vitest';
import { makeApp, btcWallet, evmWallet } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';
import type { MesaChair } from '../src/mesa/types.js';

const pmHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
const uniqueEmail = () => `htlc-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;
/** Readers mockados: o approve valida saldos on-chain — aqui interessa o fluxo, não a leitura real. */
const fundedReaders = {
  native: async () => ({ amount: 50 }),
  tokens: async () => [{ symbol: 'USDT', contract: LOCAL_TOKENS.usdtEth, amount: 10_000_000 }],
  priceUsdOf: async () => 1_000,
};
/** Carteira multichain "Verum" da cadeira: endereço principal + endereços por rede. */
const multichain = (primary: { network: string; address: string }, extra: { network: string; address: string }[]) =>
  ({ address: primary.address, network: primary.network, multichain: true, connectedAt: Date.now(), addresses: [primary, ...extra] });

describe('mesa v4 — approve cria a deal HTLC das cadeiras', () => {
  it('BTC nativo (vendedor) ↔ USDT EVM (comprador): deal HTLC criada, mesa vinculada, rota correta', async () => {
    const { app } = await makeApp({ balanceReaders: fundedReaders });
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const mesaRes = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { chairs: [
      { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'ethereum', contractOrMint: LOCAL_TOKENS.usdtEth, decimals: 6, symbol: 'tUSDT' } },
      { role: 'PAYMASTER_1', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
    ] } });
    expect(mesaRes.statusCode, mesaRes.body).toBe(201);
    const { mesaId } = mesaRes.json<{ mesaId: string }>();

    // Conecta as cadeiras diretamente (atalho de teste — a prova de posse é coberta nos testes v3).
    const seller = btcWallet(); const sellerEvm = evmWallet(); const buyer = evmWallet(); const pm1 = evmWallet();
    const mesa = app.mesa.mesaById(mesaId)!;
    const chairOf = (role: string): MesaChair => mesa.chairs.find(c => c.role === role) as MesaChair;
    chairOf('SELLER').wallet = multichain({ network: 'bitcoin', address: seller.address }, [{ network: 'ethereum', address: sellerEvm.address }]);
    chairOf('BUYER').wallet = multichain({ network: 'ethereum', address: buyer.address }, []);
    chairOf('PAYMASTER_1').wallet = multichain({ network: 'ethereum', address: pm1.address }, []);
    mesa.chairs.forEach(c => { c.firstName = c.role; c.connectedAt = Date.now(); });

    // Saldos on-chain nos SIMULADORES (o verify do motor lê o adaptador de verdade).
    app.local!.bitcoin.mint(seller.address, null, 50_000_000n);
    app.local!.evm.mint(buyer.address, LOCAL_TOKENS.usdtEth, 10n ** 12n);

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
    expect(deal.draft.assetOut.contractOrMint).toBe(LOCAL_TOKENS.usdtEth);
    expect(deal.draft.amountInBase).toBe('20000000'); // sats da config da mesa
    // Participantes nas redes das SUAS pernas, vindos da carteira multichain.
    expect(deal.participants.find(p => p.role === 'SELLER')?.address).toBe(seller.address);
    expect(deal.participants.find(p => p.role === 'BUYER')?.address).toBe(buyer.address);
    expect(app.mesa.mesaById(mesaId)!.dealId).toBe(deal.id);
    await app.close();
  }, 60_000);

  it('BTC do lado COMPRADOR → 409 com motivo nominal (limite do escrow V2)', async () => {
    const { app } = await makeApp({ balanceReaders: fundedReaders });
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const { mesaId } = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { chairs: [
      { role: 'SELLER', expectedAsset: { network: 'ethereum', contractOrMint: LOCAL_TOKENS.usdtEth, decimals: 6, symbol: 'tUSDT' } },
      { role: 'BUYER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'PAYMASTER_1', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
    ] } })).json<{ mesaId: string }>();
    const mesa = app.mesa.mesaById(mesaId)!;
    const w = (n: string, a: string) => multichain({ network: n, address: a }, []);
    mesa.chairs.forEach(c => { c.wallet = w(c.expectedAsset.network, c.expectedAsset.network === 'bitcoin' ? btcWallet().address : evmWallet().address); c.firstName = c.role; });
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaId}/config`, headers: pmHeaders(token), payload: { amountInBase: '1000000000', buyerAmountInBase: '20000000', discountBps: 0, commissionBps: 0 } });
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: pmHeaders(token), payload: {} });
    expect(ap.statusCode, ap.body).toBe(409);
    expect(ap.json<{ message: string }>().message).toContain('COMPRADOR');
    await app.close();
  }, 60_000);
});
