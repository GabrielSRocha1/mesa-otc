/**
 * ESCROW_DIRECT (token↔token na MESMA rede): aprovar deve criar o deal REAL no VerumOtcEscrow e
 * ABRIR as assinaturas (vez do Vendedor) — sem cair no helper de dev. Moeda nativa continua barrada.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, type Wallet } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';
import type { App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';

const USDT = { network: 'solana', contractOrMint: LOCAL_TOKENS.usdtSol, decimals: 6, symbol: 'USDT' };
const USDC = { network: 'solana', contractOrMint: LOCAL_TOKENS.usdcSol, decimals: 6, symbol: 'USDC' };
const readers: BalanceReaders = { native: async () => ({ amount: 1000 }), tokens: async () => [{ symbol: 'USDT', contract: LOCAL_TOKENS.usdtSol, amount: 10 ** 9 }, { symbol: 'USDC', contract: LOCAL_TOKENS.usdcSol, amount: 10 ** 9 }], priceUsdOf: async () => 1 };
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const email = () => `ed-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;

async function join(app: App, pm: string, mesaId: string, chairId: string, name: string, w: Wallet) {
  const inv = (await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${chairId}/invite`, headers: H(pm) })).json<{ inviteId: string; code: string }>();
  const ch = (await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inv.inviteId)}/challenge`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address } })).json<{ message: string; nonce: string }>();
  const j = await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inv.inviteId)}/join`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), addresses: [{ network: 'solana', address: w.address }] } });
  expect(j.statusCode).toBe(201);
  return j.json<{ token: string }>().token;
}

describe('Mesa · ESCROW_DIRECT token↔token abre assinaturas', () => {
  it('USDT ↔ USDC (Solana) → aprovar cria deal e vai para WAITING_SIGNATURES (vez do Vendedor)', async () => {
    const { app } = await makeApp({ balanceReaders: readers });
    const pm = (await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM ED', email: email(), password: 'senha-forte-1' } })).json<{ token: string }>().token;
    const pmW = solWallet();
    await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: H(pm), payload: { address: pmW.address, network: 'solana' } });
    const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: H(pm), payload: { network: 'solana', chairs: [
      { role: 'SELLER', expectedAsset: USDT }, { role: 'BUYER', expectedAsset: USDC }, { role: 'PAYMASTER_1', expectedAsset: USDT },
    ] } })).json<{ mesaId: string; chairs: { chairId: string; role: string }[] }>();
    const chair = (r: string) => mesa.chairs.find(c => c.role === r)!.chairId;
    const seller = solWallet(), buyer = solWallet();
    const sPtok = await join(app, pm, mesa.mesaId, chair('SELLER'), 'Vendedor', seller);
    await join(app, pm, mesa.mesaId, chair('BUYER'), 'Comprador', buyer);
    // Cada lado DETÉM o próprio token (o Vendedor tem o que vende; o Comprador o que paga) — no escrow
    // direto ambos depositam. No sim local, semeamos esses saldos para refletir o cenário real.
    app.local!.solana.mint(seller.address, LOCAL_TOKENS.usdtSol, 10n ** 12n);
    app.local!.solana.mint(buyer.address, LOCAL_TOKENS.usdcSol, 10n ** 12n);
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesa.mesaId}/config`, headers: H(pm), payload: { amountInBase: '100000000', discountBps: 100, commissionBps: 0 } });

    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/approve`, headers: H(pm), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201);
    const st = (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesa.mesaId}`, headers: H(sPtok) })).json<{ status: string; deal: { id: string; turnRole: string } }>();
    expect(['WAITING_SIGNATURES', 'SIGNING']).toContain(st.status);
    expect(st.deal.turnRole).toBe('SELLER');
    await app.close();
  }, 120_000);

  it('token nativo (SOL) NÃO entra no escrow direto (segue caminho legado) — aprova sem erro de "só-token"', async () => {
    // Sanidade: SOL nativo ↔ USDC não deve ser roteado p/ o escrow direto (que recusaria nativo);
    // no ambiente local o caminho legado cria o deal normalmente.
    const { app } = await makeApp({ balanceReaders: readers });
    const pm = (await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM ED2', email: email(), password: 'senha-forte-1' } })).json<{ token: string }>().token;
    const pmW = solWallet();
    await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: H(pm), payload: { address: pmW.address, network: 'solana' } });
    const SOL = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
    const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: H(pm), payload: { network: 'solana', chairs: [
      { role: 'SELLER', expectedAsset: SOL }, { role: 'BUYER', expectedAsset: USDC }, { role: 'PAYMASTER_1', expectedAsset: SOL },
    ] } })).json<{ mesaId: string; chairs: { chairId: string; role: string }[] }>();
    const chair = (r: string) => mesa.chairs.find(c => c.role === r)!.chairId;
    const seller = solWallet(), buyer = solWallet();
    await join(app, pm, mesa.mesaId, chair('SELLER'), 'Vendedor', seller);
    await join(app, pm, mesa.mesaId, chair('BUYER'), 'Comprador', buyer);
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesa.mesaId}/config`, headers: H(pm), payload: { amountInBase: '250000000000', discountBps: 100, commissionBps: 0 } });
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/approve`, headers: H(pm), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201); // caminho legado (sim local) — não barra nativo com "só-token"
    await app.close();
  }, 120_000);
});
