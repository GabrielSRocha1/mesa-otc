/**
 * Integração das rotas /v1/rooms/* (VERUM OTC §5) com sessão real de carteira e assinatura de
 * ingresso real (Solana/EVM). Prova o fluxo criar→convidar→resolver→aceitar→encerrar, a
 * anti-enumeração e o gate de sessão.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, evmWallet, solWallet } from './helpers.js';
import type { App } from '../src/app.js';
import type { Wallet } from './helpers.js';

async function login(app: App, w: Wallet): Promise<string> {
  const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=${w.network}&address=${w.address}` })).json<{ message: string; nonce: string }>();
  const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
  const v = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: w.network, address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } });
  return v.json<{ token: string }>().token;
}
const H = (token: string) => ({ authorization: `Bearer ${token}` });
const P = (app: App, token: string, url: string, payload?: Record<string, unknown>) => app.api.inject({ method: 'POST', url, headers: H(token), payload });
const G = (app: App, token: string, url: string) => app.api.inject({ method: 'GET', url, headers: H(token) });

let n = 0;
async function onboard(app: App, w: Wallet): Promise<{ token: string; email: string }> {
  const token = await login(app, w); const email = `u${++n}@empresa.com`;
  await P(app, token, '/v1/identity/account');
  await app.api.inject({ method: 'PUT', url: '/v1/identity/name', headers: H(token), payload: { fullName: `Fulano ${String.fromCharCode(65 + (n % 26))}ilvano` } });
  const es = (await P(app, token, '/v1/identity/email/start', { email })).json<{ challengeId: string; devHint: string }>();
  await P(app, token, '/v1/identity/email/confirm', { challengeId: es.challengeId, code: es.devHint });
  const ps = (await P(app, token, '/v1/identity/phone/start', { phone: `+55119${String(100000 + n).slice(-6)}0` })).json<{ challengeId: string; devHint: string }>();
  await P(app, token, '/v1/identity/phone/confirm', { challengeId: ps.challengeId, code: ps.devHint });
  return { token, email };
}

interface RoomView { id: string; status: string; members: { role: string; emailMasked: string }[]; invitations: { role: string; status: string }[] }

describe('§5 Salas — fluxo HTTP com assinatura real', () => {
  it('criar → convidar → resolver → aceitar (assinatura Solana) → encerrar; anti-enumeração e gate de sessão', async () => {
    const { app } = await makeApp();
    const pm1 = await onboard(app, evmWallet());
    const seller = solWallet(); const sellerAcc = await onboard(app, seller);

    const room = (await P(app, pm1.token, '/v1/rooms')).json<RoomView>();
    expect(room.status).toBe('OPEN'); expect(room.members).toHaveLength(1);

    // anti-enumeração: convite p/ conta existente e inexistente têm a mesma forma de resposta
    const invReal = await P(app, pm1.token, `/v1/rooms/${room.id}/invites`, { role: 'SELLER', email: sellerAcc.email });
    const invGhost = await P(app, pm1.token, `/v1/rooms/${room.id}/invites`, { role: 'BUYER', email: 'fantasma@nao-existe.com' });
    expect(invReal.statusCode).toBe(201); expect(invGhost.statusCode).toBe(201);
    expect(Object.keys(invReal.json()).sort()).toEqual(Object.keys(invGhost.json()).sort());
    const token = invReal.json<{ token: string }>().token;

    // resolve (no corpo, nunca em query) → mensagem de ingresso; assina com a carteira do vendedor
    const ch = (await P(app, sellerAcc.token, '/v1/rooms/invite/resolve', { token })).json<{ joinMessage: string; nonce: string }>();
    const signature = await seller.signMessage(ch.joinMessage);
    const acc = await P(app, sellerAcc.token, '/v1/rooms/accept', { token, nonce: ch.nonce, signature });
    expect(acc.statusCode).toBe(201);
    const v = acc.json<RoomView>();
    expect(v.members.some(m => m.role === 'SELLER')).toBe(true);
    const sellerMember = v.members.find(m => m.role === 'SELLER')!;
    expect(sellerMember.emailMasked).not.toContain(sellerAcc.email);

    // token consumido → resolver de novo falha
    expect((await P(app, sellerAcc.token, '/v1/rooms/invite/resolve', { token })).statusCode).toBe(400);

    // ticket de WS
    expect((await P(app, sellerAcc.token, `/v1/rooms/${room.id}/ws-ticket`)).statusCode).toBe(201);

    // gate de sessão
    expect((await app.api.inject({ method: 'GET', url: `/v1/rooms/${room.id}` })).statusCode).toBe(403);

    // encerrar (irreversível) revoga convites pendentes
    const closed = (await P(app, pm1.token, `/v1/rooms/${room.id}/close`, { reason: 'CANCELLED' })).json<RoomView>();
    expect(closed.status).toBe('CLOSED');
    expect((await P(app, pm1.token, `/v1/rooms/${room.id}/ws-ticket`)).statusCode).toBe(409);
    await app.close();
  });

  it('não-participante não vê a sala; OpenAPI de salas disponível', async () => {
    const { app } = await makeApp();
    const pm1 = await onboard(app, evmWallet());
    const room = (await P(app, pm1.token, '/v1/rooms')).json<{ id: string }>();
    const outsider = await onboard(app, solWallet());
    expect((await G(app, outsider.token, `/v1/rooms/${room.id}`)).statusCode).toBe(403);
    const spec = (await app.api.inject({ method: 'GET', url: '/v1/rooms/openapi.json' })).json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(spec.paths)).toContain('/v1/rooms/accept');
    await app.close();
  });
});
