/**
 * Approve da mesa → deal HTLC REAL a partir das cadeiras (v4): vendedor BTC nativo, comprador
 * token na perna EVM, endereços MULTICHAIN por perna. Simuladores locais (bitcoin regtest + evm).
 */
import { describe, it, expect } from 'vitest';
import { makeApp, btcWallet, evmWallet } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';
import { deriveSettlementPlan } from '../src/mesa/settlementPlan.js';
import type { MesaChair } from '../src/mesa/types.js';

const chair = (role: MesaChair['role'], network: string, contractOrMint: string | null, symbol: string, decimals = 6): MesaChair =>
  ({ chairId: 'ch_' + role, role, expectedAsset: { network, contractOrMint, decimals, symbol }, wallet: null });

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
    // Comprador recebe o BTC no claim → precisa de endereço Bitcoin na carteira multichain (a
    // Verum real sempre tem; o fluxo agora valida isso no approve em vez de falhar no settle).
    chairOf('BUYER').wallet = multichain({ network: 'ethereum', address: buyer.address }, [{ network: 'bitcoin', address: btcWallet().address }]);
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

    // RECONEXÃO DE SESSÃO (auditoria 2026-10-19): a reentrada identifica a cadeira por QUALQUER
    // endereço multichain, mas o desafio nasce na rede/endereço do PARTICIPANTE DO DEAL (Vendedor
    // BTC assina em bitcoin) — e a sessão emitida passa no gate do depósito (a sessão stale que
    // dava "só a carteira do papel deposita" se auto-cura por este caminho).
    const ch = await app.mesa.reenterChallenge(mesaId, { network: 'ethereum', address: sellerEvm.address, addresses: [{ network: 'ethereum', address: sellerEvm.address }] });
    expect(ch.network).toBe('bitcoin');
    expect(ch.address).toBe(seller.address);
    const re = await app.mesa.reenterMesa(mesaId, { network: 'bitcoin', address: seller.address, nonce: ch.nonce, signature: await seller.signMessage!(ch.message) });
    expect(re.role).toBe('SELLER');
    const dep = await app.api.inject({ method: 'POST', url: `/v1/deals/${deal.id}/legs/0/deposit`, headers: { authorization: `Bearer ${re.token}`, 'idempotency-key': 'reenter-deposit-1' }, payload: {} });
    expect(dep.statusCode, dep.body).toBe(200); // sessão renasceu no endereço do papel → gate do depósito passa
    await app.close();
  }, 60_000);

  it('BTC do lado COMPRADOR → plano HTLC_BTC com btcSide BUYER (perna externa do comprador suportada)', () => {
    // A trava antiga ("BTC do COMPRADOR não é suportado") foi removida — o escrow V2.2 tem a
    // perna externa do comprador. O plano reconhece o lado corretamente.
    const plan = deriveSettlementPlan([
      chair('SELLER', 'ethereum', LOCAL_TOKENS.usdtEth, 'tUSDT', 6),
      chair('BUYER', 'bitcoin', null, 'BTC', 8),
    ]);
    expect(plan?.mode).toBe('HTLC_BTC');
    expect(plan?.htlc?.btcSide).toBe('BUYER');
    // BTC↔Solana agora é suportado (escrow N-de-N Solana COM hashlock = settle_xchain, ADR-v5): o
    // plano deriva HTLC_BTC e a criação usa o fluxo createMesaBtcSolanaDeal (token SPL na Solana).
    const planSol = deriveSettlementPlan([
      chair('SELLER', 'solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'tUSDC', 6),
      chair('BUYER', 'bitcoin', null, 'BTC', 8),
    ]);
    expect(planSol?.mode).toBe('HTLC_BTC');
    expect(planSol?.htlc?.btcSide).toBe('BUYER');
  });
});
