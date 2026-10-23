/**
 * Operar Indexado — e2e pela API: configurar/fixar/ler/aprovar; o fixing entra no deal assinado; só o
 * Pay Master 1 escreve; FIXED continua idêntico (sem indexedFixingHash). Usa o MockIndexProvider de dev.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, type Wallet } from './helpers.js';
import { LOCAL_TOKENS, type App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';

const USDT = { network: 'solana', contractOrMint: LOCAL_TOKENS.usdtSol, decimals: 6, symbol: 'USDT' };
const USDC = { network: 'solana', contractOrMint: LOCAL_TOKENS.usdcSol, decimals: 6, symbol: 'USDC' };
const readers: BalanceReaders = { native: async () => ({ amount: 1000 }), tokens: async () => [{ symbol: 'USDT', contract: LOCAL_TOKENS.usdtSol, amount: 10 ** 9 }, { symbol: 'USDC', contract: LOCAL_TOKENS.usdcSol, amount: 10 ** 9 }], priceUsdOf: async () => 1 };
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const email = () => `ix-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;

async function join(app: App, pm: string, mesaId: string, chairId: string, name: string, w: Wallet) {
  const inv = (await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${chairId}/invite`, headers: H(pm) })).json<{ inviteId: string; code: string }>();
  const ch = (await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inv.inviteId)}/challenge`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address } })).json<{ message: string; nonce: string }>();
  const j = await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inv.inviteId)}/join`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), addresses: [{ network: 'solana', address: w.address }] } });
  expect(j.statusCode).toBe(201);
  return j.json<{ token: string }>().token;
}

async function setupMesa(app: App) {
  const pm = (await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM IX', email: email(), password: 'senha-forte-1' } })).json<{ token: string }>().token;
  const pmW = solWallet();
  await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: H(pm), payload: { address: pmW.address, network: 'solana' } });
  const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: H(pm), payload: { network: 'solana', chairs: [
    { role: 'SELLER', expectedAsset: USDT }, { role: 'BUYER', expectedAsset: USDC }, { role: 'PAYMASTER_1', expectedAsset: USDT },
  ] } })).json<{ mesaId: string; chairs: { chairId: string; role: string }[] }>();
  const chair = (r: string) => mesa.chairs.find(c => c.role === r)!.chairId;
  const seller = solWallet(), buyer = solWallet();
  const sellerTok = await join(app, pm, mesa.mesaId, chair('SELLER'), 'Vendedor', seller);
  await join(app, pm, mesa.mesaId, chair('BUYER'), 'Comprador', buyer);
  app.local!.solana.mint(seller.address, LOCAL_TOKENS.usdtSol, 10n ** 12n);
  app.local!.solana.mint(buyer.address, LOCAL_TOKENS.usdcSol, 10n ** 12n);
  return { pm, mesaId: mesa.mesaId, sellerTok };
}

describe('Operar Indexado · e2e pela API', () => {
  it('configura, fixa, aprova → o quoteAmount fixado e o fixingHash entram no deal assinado', async () => {
    const { app } = await makeApp({ balanceReaders: readers });
    const { pm, mesaId, sellerTok } = await setupMesa(app);

    const cfg = await app.api.inject({ method: 'POST', url: `/v1/mesas/${mesaId}/indexed-pricing`, headers: H(pm), payload: { spreadBps: 100, baseAmount: '100000000' } });
    expect(cfg.statusCode, cfg.body).toBe(201);
    const fix = await app.api.inject({ method: 'POST', url: `/v1/mesas/${mesaId}/indexed-pricing/fix`, headers: H(pm), payload: {} });
    expect(fix.statusCode, fix.body).toBe(201);
    const fixed = fix.json<{ record: { status: string; fixingHash: string; quoteAmount: string }; config: { amountInBase: string; buyerAmountInBase: string } }>();
    expect(fixed.record.status).toBe('FIXED');
    expect(fixed.config.buyerAmountInBase).toBe(fixed.record.quoteAmount);

    // Leitura pelo PARTICIPANTE (Vendedor): somente leitura, vê fontes/dispersão/valores.
    const view = (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaId}/indexed-pricing`, headers: H(sellerTok) })).json<{ mode: string; record: { fixingHash: string; fixingSources: unknown[] } }>();
    expect(view.mode).toBe('INDEXED_VERUM_SWAP');
    expect(view.record.fixingHash).toBe(fixed.record.fixingHash);
    expect(view.record.fixingSources!.length).toBeGreaterThanOrEqual(2);

    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: H(pm), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201);
    const st = (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaId}`, headers: H(sellerTok) })).json<{ deal: { id: string } }>();
    const deal = await app.deals.get(st.deal.id);
    // O fixing (hash) foi congelado no pricing assinado pelos 4…
    expect(deal.terms!.pricing.indexedFixingHash).toBe(fixed.record.fixingHash);
    // …e a perna do COMPRADOR é EXATAMENTE o quoteAmount fixado (não o amountOut do oráculo).
    expect(deal.terms!.legs[1]!.amountBase).toBe(fixed.record.quoteAmount);
    await app.close();
  }, 120_000);

  it('só o Pay Master 1 escreve — participante recebe 403', async () => {
    const { app } = await makeApp({ balanceReaders: readers });
    const { mesaId, sellerTok } = await setupMesa(app);
    const r1 = await app.api.inject({ method: 'POST', url: `/v1/mesas/${mesaId}/indexed-pricing`, headers: H(sellerTok), payload: { spreadBps: 50 } });
    expect(r1.statusCode).toBe(403);
    const r2 = await app.api.inject({ method: 'POST', url: `/v1/mesas/${mesaId}/indexed-pricing/fix`, headers: H(sellerTok), payload: {} });
    expect(r2.statusCode).toBe(403);
    await app.close();
  }, 120_000);

  it('REGRESSÃO: mesa FIXED continua idêntica (deal sem indexedFixingHash)', async () => {
    const { app } = await makeApp({ balanceReaders: readers });
    const { pm, mesaId, sellerTok } = await setupMesa(app);
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaId}/config`, headers: H(pm), payload: { amountInBase: '100000000', discountBps: 100, commissionBps: 0 } });
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: H(pm), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201);
    const st = (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaId}`, headers: H(sellerTok) })).json<{ deal: { id: string } }>();
    const deal = await app.deals.get(st.deal.id);
    expect(deal.terms!.pricing.indexedFixingHash).toBeUndefined();
    await app.close();
  }, 120_000);
});
