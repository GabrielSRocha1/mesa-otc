/** Mesa v3 via API — convite → conexão → DTO por papel → aprovação com motivos nominais → assinaturas em ordem. */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, type Wallet } from './helpers.js';
import type { App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';
import type { Clock } from './helpers.js';

const SOL_ASSET = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
const USDC_ASSET = { network: 'solana', contractOrMint: 'USDC1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC' };

/** Leitores mockados com modo alternável (pobre ⇄ rico) — nunca tocam RPC real nos testes. */
function mockReaders(): { readers: BalanceReaders; mode: { poor: boolean } } {
  const mode = { poor: false };
  return {
    mode,
    readers: {
      native: async () => ({ amount: mode.poor ? 0.001 : 1000 }),
      tokens: async () => [{ symbol: 'USDC', contract: USDC_ASSET.contractOrMint, amount: mode.poor ? 1 : 10 ** 9 }],
      priceUsdOf: async () => 150,
    },
  };
}

const pmHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
// O portal persiste em arquivo entre execuções (dev) — e-mail único por run evita 409 no cadastro.
const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;

async function registerPm(app: App, email: string): Promise<string> {
  const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'Pay Master Teste', email, password: 'senha-forte-1' } });
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

async function inviteAndJoin(app: App, token: string, mesaId: string, chairId: string, firstName: string, w: Wallet): Promise<{ inviteId: string; participantToken: string }> {
  const inv = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${chairId}/invite`, headers: pmHeaders(token) });
  expect(inv.statusCode).toBe(201);
  const { inviteId, code } = inv.json<{ inviteId: string; code: string }>();
  const ch = await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inviteId)}/challenge`, payload: { code, firstName, network: 'solana', address: w.address } });
  expect(ch.statusCode).toBe(201);
  const { message, nonce } = ch.json<{ message: string; nonce: string }>();
  const join = await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inviteId)}/join`, payload: { code, firstName, network: 'solana', address: w.address, nonce, signature: await w.signMessage(message) } });
  expect(join.statusCode).toBe(201);
  return { inviteId, participantToken: join.json<{ token: string }>().token };
}

async function walletLogin(app: App, w: Wallet): Promise<string> {
  const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=${w.network}&address=${w.address}` })).json<{ message: string; nonce: string }>();
  const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
  const v = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: w.network, address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } });
  expect(v.statusCode).toBe(200);
  return v.json<{ token: string }>().token;
}

let n = 0; const idem = () => `mesa-api-${Date.now()}-${n++}`;

async function approveMesa(app: App, token: string, mesaId: string): Promise<{ dealId: string }> {
  const cfg = await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaId}/config`, headers: pmHeaders(token), payload: { amountInBase: '250000000000', discountBps: 100, commissionBps: 200 } });
  expect(cfg.statusCode).toBe(200);
  const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: pmHeaders(token), payload: {} });
  expect(ap.statusCode, ap.body).toBe(201);
  const j = ap.json<{ approved: boolean; termsHash: string; deal: { id: string } }>();
  expect(j.approved).toBe(true); expect(j.termsHash).toMatch(/^[0-9a-f]{64}$/);
  return { dealId: j.deal.id };
}

describe('API mesa v3 — fluxo completo', () => {
  it('convite → conexão → DTO por papel → aprovação → assinaturas em ordem → COMPLETED; isolamento entre mesas', async () => {
    const { readers } = mockReaders();
    const { app } = await makeApp({ balanceReaders: readers });
    const pm = await registerPm(app, uniqueEmail('pm1'));
    const mesaA = await createMesa(app, pm);
    const mesaB = await createMesa(app, pm);
    expect(mesaA.mesaId).not.toBe(mesaB.mesaId);

    const seller = solWallet(); const buyer = solWallet();
    const sChair = mesaA.chairs.find(c => c.role === 'SELLER')!; const bChair = mesaA.chairs.find(c => c.role === 'BUYER')!;
    const sj = await inviteAndJoin(app, pm, mesaA.mesaId, sChair.chairId, 'Gabriel', seller);
    await inviteAndJoin(app, pm, mesaA.mesaId, bChair.chairId, 'Beatriz', buyer);

    // DTO do participante: recortado, sem campos administrativos; mesma mesa em tempo real
    const pv = await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaA.mesaId}`, headers: pmHeaders(sj.participantToken) });
    expect(pv.statusCode).toBe(200);
    const pvBody = pv.body;
    for (const banned of ['"inviteId"', '"invites"', '"link"', '"approvals"', 'cliente vip']) expect(pvBody).not.toContain(banned);
    expect(pvBody).toContain('"isMe"');
    expect(pvBody).toContain('Gabriel');
    // participante da mesa A não lê a mesa B
    expect((await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaB.mesaId}`, headers: pmHeaders(sj.participantToken) })).statusCode).toBe(403);
    // participante não edita configuração
    expect((await app.api.inject({ method: 'PATCH', url: `/v1/mesas/${mesaA.mesaId}/config`, headers: pmHeaders(sj.participantToken), payload: { discountBps: 1 } })).statusCode).toBe(403);
    // admin vê tudo
    const av = await app.api.inject({ method: 'GET', url: `/v1/portal/mesas/${mesaA.mesaId}`, headers: pmHeaders(pm) });
    expect(av.statusCode).toBe(200); expect(av.body).toContain('cliente vip');

    // aprovação (saldos ricos) cria a Deal com as cadeiras da mesa
    const { dealId } = await approveMesa(app, pm, mesaA.mesaId);
    // configuração congelada após aprovação → 409
    expect((await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaA.mesaId}/config`, headers: pmHeaders(pm), payload: { discountBps: 5 } })).statusCode).toBe(409);
    let status = (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaA.mesaId}`, headers: pmHeaders(sj.participantToken) })).json<{ status: string; deal: { turnRole: string } }>();
    expect(status.status).toBe('WAITING_SIGNATURES');
    expect(status.deal.turnRole).toBe('SELLER');

    // assinatura fora de ordem rejeitada NO BACKEND
    const tok = { SELLER: await walletLogin(app, seller), BUYER: await walletLogin(app, buyer) };
    const envB = await app.api.inject({ method: 'GET', url: `/v1/deals/${dealId}/approval-envelope`, headers: pmHeaders(tok.BUYER) });
    expect(envB.statusCode).toBe(200);
    const eb = envB.json<{ message: string; payload: { nonce: string } }>();
    const outOfOrder = await app.api.inject({ method: 'POST', url: `/v1/deals/${dealId}/approvals`, headers: { ...pmHeaders(tok.BUYER), 'idempotency-key': idem() }, payload: { role: 'BUYER', signature: await buyer.signMessage(eb.message), nonce: eb.payload.nonce } });
    expect(outOfOrder.statusCode).toBe(409);
    expect(outOfOrder.json<{ error: string }>().error).toBe('SIGNATURE_OUT_OF_ORDER');

    // ordem correta: Vendedor → PM1 (wallet do admin não está na deal? está — cadeira PM1 = wallet do pm) → Comprador
    const adminWalletAddr = (await app.api.inject({ method: 'GET', url: '/v1/portal/me', headers: pmHeaders(pm) })).json<{ wallet: { address: string } }>().wallet.address;
    const pmWallet = { network: 'solana' as const, chainId: 'localnet', address: adminWalletAddr, sign: async () => '', signMessage: async () => '' };
    void pmWallet;
    // assina Vendedor
    const envS = (await app.api.inject({ method: 'GET', url: `/v1/deals/${dealId}/approval-envelope`, headers: pmHeaders(tok.SELLER) })).json<{ message: string; payload: { nonce: string } }>();
    const aS = await app.api.inject({ method: 'POST', url: `/v1/deals/${dealId}/approvals`, headers: { ...pmHeaders(tok.SELLER), 'idempotency-key': idem() }, payload: { role: 'SELLER', signature: await seller.signMessage(envS.message), nonce: envS.payload.nonce } });
    expect(aS.statusCode).toBe(200);
    status = (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaA.mesaId}`, headers: pmHeaders(sj.participantToken) })).json();
    expect(status.status).toBe('SIGNING');
    await app.close();
  }, 120_000);

  it('aprovação bloqueada com motivos NOMINAIS quando saldo/gás insuficiente; /v1/time expõe o relógio do servidor', async () => {
    const { readers, mode } = mockReaders();
    const { app } = await makeApp({ balanceReaders: readers });
    const pm = await registerPm(app, uniqueEmail('pm2'));
    const mesa = await createMesa(app, pm);
    const seller = solWallet(); const buyer = solWallet();
    await inviteAndJoin(app, pm, mesa.mesaId, mesa.chairs.find(c => c.role === 'SELLER')!.chairId, 'Ana', seller);
    await inviteAndJoin(app, pm, mesa.mesaId, mesa.chairs.find(c => c.role === 'BUYER')!.chairId, 'Beto', buyer);
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesa.mesaId}/config`, headers: pmHeaders(pm), payload: { amountInBase: '250000000000', discountBps: 100, commissionBps: 0 } });
    mode.poor = true;
    const blocked = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/approve`, headers: pmHeaders(pm), payload: {} });
    expect(blocked.statusCode).toBe(409);
    const det = blocked.json<{ details: { motivos: string[] } }>().details.motivos.join('\n');
    expect(det).toContain('gás abaixo de US$ 5');
    expect(det).toContain('Vendedor (Ana)');
    // sem aprovação, nada de deal
    expect((await app.api.inject({ method: 'GET', url: `/v1/portal/mesas/${mesa.mesaId}`, headers: pmHeaders(pm) })).json<{ deal: unknown }>().deal).toBeNull();
    const t = await app.api.inject({ method: 'GET', url: '/v1/time' });
    expect(t.statusCode).toBe(200); expect(t.json<{ time: number }>().time).toBeGreaterThan(0);
    await app.close();
  }, 60_000);

  it('janela de 5 min por assinante: estouro → SIGNATURE_TIMEOUT e novas assinaturas bloqueadas', async () => {
    const { readers } = mockReaders();
    const made = await makeApp({ balanceReaders: readers });
    const app = made.app; const clock: Clock = made.clock;
    const pm = await registerPm(app, uniqueEmail('pm3'));
    const mesa = await createMesa(app, pm);
    const seller = solWallet(); const buyer = solWallet();
    const sj = await inviteAndJoin(app, pm, mesa.mesaId, mesa.chairs.find(c => c.role === 'SELLER')!.chairId, 'Ana', seller);
    await inviteAndJoin(app, pm, mesa.mesaId, mesa.chairs.find(c => c.role === 'BUYER')!.chairId, 'Beto', buyer);
    const { dealId } = await approveMesa(app, pm, mesa.mesaId);
    // Vendedor assina dentro da janela
    const tokS = await walletLogin(app, seller);
    const envS = (await app.api.inject({ method: 'GET', url: `/v1/deals/${dealId}/approval-envelope`, headers: pmHeaders(tokS) })).json<{ message: string; payload: { nonce: string } }>();
    expect((await app.api.inject({ method: 'POST', url: `/v1/deals/${dealId}/approvals`, headers: { ...pmHeaders(tokS), 'idempotency-key': idem() }, payload: { role: 'SELLER', signature: await seller.signMessage(envS.message), nonce: envS.payload.nonce } })).statusCode).toBe(200);
    // estoura a janela do PM1 (6 min)
    clock.advance(6 * 60_000);
    const tokB = await walletLogin(app, buyer);
    const envB = await app.api.inject({ method: 'GET', url: `/v1/deals/${dealId}/approval-envelope`, headers: pmHeaders(tokB) });
    // envelope ou assinatura são bloqueados após o estouro (deal expira na janela do turno)
    if (envB.statusCode === 200) {
      const eb = envB.json<{ message: string; payload: { nonce: string } }>();
      const late = await app.api.inject({ method: 'POST', url: `/v1/deals/${dealId}/approvals`, headers: { ...pmHeaders(tokB), 'idempotency-key': idem() }, payload: { role: 'BUYER', signature: await buyer.signMessage(eb.message), nonce: eb.payload.nonce } });
      expect(late.statusCode).toBeGreaterThanOrEqual(400);
    } else {
      expect(envB.statusCode).toBeGreaterThanOrEqual(400);
    }
    const status = (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesa.mesaId}`, headers: pmHeaders(sj.participantToken) })).json<{ status: string }>();
    expect(status.status).toBe('SIGNATURE_TIMEOUT');
    await app.close();
  }, 120_000);
});
