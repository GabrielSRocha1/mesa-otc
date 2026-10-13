/**
 * Teste de SEGURANÇA — superfície de ataque da mesa v3 (convite → prova de posse → assinatura)
 * e das rotas públicas/administrativas. Cada caso é adversarial: tenta burlar um controle e exige
 * que o backend rejeite (status/código corretos) ou não vaze segredo.
 *
 * Cobre: assinatura forjada, replay/vínculo de nonce, código de convite errado, nonce cruzado
 * entre convites, ordem obrigatória de assinatura, liquidação só em N/N, autenticação das rotas
 * do portal, isolamento participante×admin e não-vazamento de segredos na public-view.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, prepareDeal, signAs, type Parts } from './helpers.js';
import type { App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';
import { SIGNING_ORDER, type Role } from '../src/domain/types.js';

const SOL_ASSET = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
const USDC_ASSET = { network: 'solana', contractOrMint: 'USDC1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC' };

function mockReaders(): BalanceReaders {
  return { native: async () => ({ amount: 1000 }), tokens: async () => [{ symbol: 'USDC', contract: USDC_ASSET.contractOrMint, amount: 10 ** 9 }], priceUsdOf: async () => 150 };
}
const pmHeaders = (t: string) => ({ authorization: `Bearer ${t}` });
const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;

async function registerPm(app: App, email = uniqueEmail('sec')): Promise<string> {
  const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM Seg', email, password: 'senha-forte-1' } });
  expect(r.statusCode).toBe(201);
  const token = r.json<{ token: string }>().token;
  const w = solWallet();
  const c = await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: pmHeaders(token), payload: { address: w.address, network: 'solana' } });
  expect(c.statusCode).toBe(200);
  return token;
}
async function createMesa(app: App, token: string): Promise<{ mesaId: string; chairs: { chairId: string; role: string }[] }> {
  const r = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { network: 'solana', chairs: [
    { role: 'SELLER', expectedAsset: SOL_ASSET, label: 'cliente vip' },
    { role: 'BUYER', expectedAsset: USDC_ASSET },
    { role: 'PAYMASTER_1', expectedAsset: SOL_ASSET },
  ] } });
  expect(r.statusCode).toBe(201);
  return r.json();
}
async function makeInvite(app: App, token: string, mesaId: string, chairId: string): Promise<{ inviteId: string; code: string }> {
  const inv = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${chairId}/invite`, headers: pmHeaders(token) });
  expect(inv.statusCode).toBe(201);
  return inv.json();
}
async function challenge(app: App, inviteId: string, body: Record<string, unknown>) {
  return app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inviteId)}/challenge`, payload: body });
}
async function join(app: App, inviteId: string, body: Record<string, unknown>) {
  return app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inviteId)}/join`, payload: body });
}

describe('Segurança · prova de posse do convite (assinatura/nonce)', () => {
  it('rejeita assinatura FORJADA: endereço da vítima + assinatura de outra chave ⇒ SIGNATURE_INVALID', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const pm = await registerPm(app); const mesa = await createMesa(app, pm);
    const seat = mesa.chairs.find(c => c.role === 'SELLER')!;
    const { inviteId, code } = await makeInvite(app, pm, mesa.mesaId, seat.chairId);

    const victim = solWallet();   // endereço que o atacante alega controlar
    const attacker = solWallet(); // chave que o atacante realmente possui
    const ch = await challenge(app, inviteId, { code, firstName: 'Mallory', network: 'solana', address: victim.address });
    expect(ch.statusCode).toBe(201);
    const { message, nonce } = ch.json<{ message: string; nonce: string }>();

    // Assina a mensagem canônica, mas com a chave ERRADA (do atacante).
    const forged = await attacker.signMessage(message);
    const r = await join(app, inviteId, { code, firstName: 'Mallory', network: 'solana', address: victim.address, nonce, signature: forged });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toBe('SIGNATURE_INVALID');
  });

  it('nonce é VINCULADO à carteira: desafio de A não serve para B ⇒ NONCE_INVALID', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const pm = await registerPm(app); const mesa = await createMesa(app, pm);
    const seat = mesa.chairs.find(c => c.role === 'SELLER')!;
    const { inviteId, code } = await makeInvite(app, pm, mesa.mesaId, seat.chairId);

    const a = solWallet(); const b = solWallet();
    const ch = await challenge(app, inviteId, { code, firstName: 'Alice', network: 'solana', address: a.address });
    const { nonce } = ch.json<{ nonce: string }>();
    // B tenta entrar com o nonce emitido para A (assina a própria mensagem que acha correta).
    const r = await join(app, inviteId, { code, firstName: 'Alice', network: 'solana', address: b.address, nonce, signature: await b.signMessage('qualquer') });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toBe('NONCE_INVALID');
  });

  it('replay: nonce já consumido não entra de novo ⇒ rejeitado', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const pm = await registerPm(app); const mesa = await createMesa(app, pm);
    const seat = mesa.chairs.find(c => c.role === 'SELLER')!;
    const { inviteId, code } = await makeInvite(app, pm, mesa.mesaId, seat.chairId);

    const w = solWallet();
    const ch = await challenge(app, inviteId, { code, firstName: 'Bob', network: 'solana', address: w.address });
    const { message, nonce } = ch.json<{ message: string; nonce: string }>();
    const sig = await w.signMessage(message);
    const first = await join(app, inviteId, { code, firstName: 'Bob', network: 'solana', address: w.address, nonce, signature: sig });
    expect(first.statusCode).toBe(201);
    // Replay idêntico: mesmo nonce + mesma assinatura.
    const replay = await join(app, inviteId, { code, firstName: 'Bob', network: 'solana', address: w.address, nonce, signature: sig });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('código do convite errado ⇒ FORBIDDEN (não deixa adivinhar por brute force silencioso)', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const pm = await registerPm(app); const mesa = await createMesa(app, pm);
    const seat = mesa.chairs.find(c => c.role === 'SELLER')!;
    const { inviteId } = await makeInvite(app, pm, mesa.mesaId, seat.chairId);
    const w = solWallet();
    const r = await challenge(app, inviteId, { code: 'ZZZZ-ZZZZ', firstName: 'Eve', network: 'solana', address: w.address });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('nonce cruzado: desafio do convite 1 não vale no convite 2 ⇒ NONCE_INVALID', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const pm = await registerPm(app); const mesa = await createMesa(app, pm);
    const seller = mesa.chairs.find(c => c.role === 'SELLER')!;
    const buyer = mesa.chairs.find(c => c.role === 'BUYER')!;
    const inv1 = await makeInvite(app, pm, mesa.mesaId, seller.chairId);
    const inv2 = await makeInvite(app, pm, mesa.mesaId, buyer.chairId);

    const w = solWallet();
    const ch = await challenge(app, inv1.inviteId, { code: inv1.code, firstName: 'Carol', network: 'solana', address: w.address });
    const { message, nonce } = ch.json<{ message: string; nonce: string }>();
    // Usa o nonce do convite 1 para entrar no convite 2.
    const r = await join(app, inv2.inviteId, { code: inv2.code, firstName: 'Carol', network: 'solana', address: w.address, nonce, signature: await w.signMessage(message) });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toBe('NONCE_INVALID');
  });
});

describe('Segurança · ordem obrigatória e liquidação N/N', () => {
  it('Comprador não assina antes do Vendedor ⇒ SIGNATURE_OUT_OF_ORDER', async () => {
    const { app } = await makeApp();
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const deal = await prepareDeal(app, parts);
    await app.deals.open(deal.id, parts.SELLER.address);
    const t = (await app.deals.get(deal.id)).terms!;
    for (const leg of t.legs) await app.deals.fund(deal.id, leg.from, parts[leg.from]!.address);
    // BUYER é o último na ordem (Vendedor → PM1 → PM2 → Comprador): assinar agora deve falhar.
    await expect(signAs(app, deal.id, 'BUYER', parts.BUYER)).rejects.toMatchObject({ code: 'SIGNATURE_OUT_OF_ORDER' });
  });

  it('assinaturas parciais NÃO liquidam; só N/N chega a COMPLETED/SETTLED', async () => {
    const { app } = await makeApp();
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const deal = await prepareDeal(app, parts);
    await app.deals.open(deal.id, parts.SELLER.address);
    const t = (await app.deals.get(deal.id)).terms!;
    for (const leg of t.legs) await app.deals.fund(deal.id, leg.from, parts[leg.from]!.address);

    const order: Role[] = SIGNING_ORDER.filter(r => parts[r] != null);
    // Assina todos MENOS o último: não pode liquidar.
    for (const role of order.slice(0, -1)) await signAs(app, deal.id, role, parts[role]!);
    const partial = await app.deals.get(deal.id);
    expect(partial.validSignatures).toBeLessThan(partial.requiredSignatures);
    expect(['SETTLED', 'COMPLETED']).not.toContain(partial.state);

    // Último assina → fecha N/N.
    const last = order[order.length - 1]!;
    await signAs(app, deal.id, last, parts[last]!);
    const full = await app.deals.get(deal.id);
    expect(full.validSignatures).toBe(full.requiredSignatures);
    expect(full.state).not.toBe('AWAITING_SIGNATURES');
  });
});

describe('Segurança · autenticação e isolamento de papéis', () => {
  it('rotas do portal exigem autenticação (sem Bearer ⇒ acesso negado 401/403)', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const denied = (s: number) => s === 401 || s === 403;
    for (const url of ['/v1/portal/mesas', '/v1/portal/operations']) {
      const r = await app.api.inject({ method: 'GET', url });
      expect(denied(r.statusCode), `${url} → ${r.statusCode}`).toBe(true);
    }
    // Corpo VÁLIDO (2+ cadeiras) sem token: a validação passa e cai no controle de auth.
    const create = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', payload: { network: 'solana', chairs: [
      { role: 'SELLER', expectedAsset: SOL_ASSET },
      { role: 'BUYER', expectedAsset: USDC_ASSET },
    ] } });
    expect(denied(create.statusCode), `POST mesas → ${create.statusCode}`).toBe(true);
  });

  it('token de PARTICIPANTE não acessa rota de ADMIN da mesa', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const pm = await registerPm(app); const mesa = await createMesa(app, pm);
    const seat = mesa.chairs.find(c => c.role === 'SELLER')!;
    const { inviteId, code } = await makeInvite(app, pm, mesa.mesaId, seat.chairId);
    const w = solWallet();
    const ch = await challenge(app, inviteId, { code, firstName: 'Dani', network: 'solana', address: w.address });
    const { message, nonce } = ch.json<{ message: string; nonce: string }>();
    const j = await join(app, inviteId, { code, firstName: 'Dani', network: 'solana', address: w.address, nonce, signature: await w.signMessage(message) });
    expect(j.statusCode).toBe(201);
    const partToken = j.json<{ token: string }>().token;

    // Com o token do participante, tenta gerar convite (ação de admin) → negado.
    const r = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/chairs/${seat.chairId}/invite`, headers: pmHeaders(partToken) });
    expect(r.statusCode).toBeGreaterThanOrEqual(401);
    expect(r.statusCode).toBeLessThan(500);
  });
});

describe('Segurança · public-view não vaza segredos', () => {
  it('public-view não expõe código/hash do convite, token, notas nem endereço completo', async () => {
    const { app } = await makeApp({ balanceReaders: mockReaders() });
    const pm = await registerPm(app); const mesa = await createMesa(app, pm);
    const seat = mesa.chairs.find(c => c.role === 'SELLER')!;
    const { inviteId, code } = await makeInvite(app, pm, mesa.mesaId, seat.chairId);
    const w = solWallet();
    const ch = await challenge(app, inviteId, { code, firstName: 'Fil', network: 'solana', address: w.address });
    const { message, nonce } = ch.json<{ message: string; nonce: string }>();
    await join(app, inviteId, { code, firstName: 'Fil', network: 'solana', address: w.address, nonce, signature: await w.signMessage(message) });

    const pv = await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesa.mesaId}/public-view` });
    expect(pv.statusCode).toBe(200);
    const raw = pv.body;
    // Nenhum segredo no corpo cru.
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(inviteId);
    expect(raw.toLowerCase()).not.toContain('codehash');
    expect(raw.toLowerCase()).not.toContain('token');
    // Endereço completo da wallet conectada NÃO aparece (só forma curta com reticências).
    expect(raw).not.toContain(w.address);
    const view = pv.json<{ chairs: { wallet: string | null; connected: boolean }[] }>();
    const connected = view.chairs.find(c => c.connected)!;
    expect(connected.wallet).toBeTruthy();
    expect(connected.wallet!).not.toBe(w.address);
    expect(connected.wallet!).toContain('…');
  });
});
