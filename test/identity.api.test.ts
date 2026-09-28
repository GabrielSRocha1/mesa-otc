/**
 * Integração das rotas /v1/identity/* (VERUM OTC §2). Dirige o onboarding completo
 * com sessão real de carteira (challenge/verify), OTP de e-mail/telefone e endereço
 * de liquidação com prova de posse. Prova também o OpenAPI e o gate de sessão.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, evmWallet, solWallet } from './helpers.js';
import type { App } from '../src/app.js';
import type { Wallet } from './helpers.js';

async function login(app: App, w: Wallet): Promise<string> {
  const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=${w.network}&address=${w.address}` })).json<{ message: string; nonce: string }>();
  const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
  const v = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: w.network, address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } });
  expect(v.statusCode).toBe(200); return v.json<{ token: string }>().token;
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const jpost = (app: App, token: string, url: string, payload?: Record<string, unknown>) => app.api.inject({ method: 'POST', url, headers: auth(token), payload });
const jput = (app: App, token: string, url: string, payload?: Record<string, unknown>) => app.api.inject({ method: 'PUT', url, headers: auth(token), payload });
const jget = (app: App, token: string, url: string) => app.api.inject({ method: 'GET', url, headers: auth(token) });

interface IdentityView { verificationLevel: string; hasName: boolean; email: { verified: boolean; masked: string }; phone: { verified: boolean; masked: string }; eligibility: { eligible: boolean }; settlementAddresses: { caip10: string }[] }

describe('§2 Rotas de identidade — onboarding completo', () => {
  it('conta → nome → e-mail (OTP) → telefone (OTP) → elegível; e-mail mascarado a terceiros', async () => {
    const { app } = await makeApp(); const token = await login(app, evmWallet());
    const acc = await jpost(app, token, '/v1/identity/account'); expect(acc.statusCode).toBe(201);
    expect(acc.json<IdentityView>().verificationLevel).toBe('BASIC');
    expect((await jget(app, token, '/v1/identity/eligibility')).json<{ eligible: boolean }>().eligible).toBe(false);

    expect((await jput(app, token, '/v1/identity/name', { fullName: 'João da Silva' })).json<IdentityView>().hasName).toBe(true);

    const es = await jpost(app, token, '/v1/identity/email/start', { email: 'joao@empresa.com' });
    expect(es.statusCode).toBe(201);
    const e = es.json<{ challengeId: string; masked: string; devHint: string }>();
    expect(e.masked).not.toContain('joao@empresa.com'); expect(e.devHint).toMatch(/^\d{6}$/);
    expect((await jpost(app, token, '/v1/identity/email/confirm', { challengeId: e.challengeId, code: '000000' })).statusCode).toBe(400); // errado
    expect((await jpost(app, token, '/v1/identity/email/confirm', { challengeId: e.challengeId, code: e.devHint })).json<IdentityView>().email.verified).toBe(true);

    const ps = await jpost(app, token, '/v1/identity/phone/start', { phone: '+5511999998888' });
    const p = ps.json<{ challengeId: string; devHint: string }>();
    const done = (await jpost(app, token, '/v1/identity/phone/confirm', { challengeId: p.challengeId, code: p.devHint })).json<IdentityView>();
    expect(done.phone.verified).toBe(true);
    expect(done.eligibility.eligible).toBe(true);
    expect(done.phone.masked).not.toContain('999998888');
    await app.close();
  });

  it('e-mail já usado por outra conta/carteira é rejeitado (409)', async () => {
    const { app } = await makeApp();
    const t1 = await login(app, evmWallet()); await jpost(app, t1, '/v1/identity/account');
    const es = await jpost(app, t1, '/v1/identity/email/start', { email: 'dup@x.com' });
    const e = es.json<{ challengeId: string; devHint: string }>();
    await jpost(app, t1, '/v1/identity/email/confirm', { challengeId: e.challengeId, code: e.devHint });
    const t2 = await login(app, solWallet());
    const dup = await jpost(app, t2, '/v1/identity/email/start', { email: 'dup@x.com' });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it('endereço de liquidação exige prova de posse (assinatura de desafio) e vincula na whitelist', async () => {
    const { app } = await makeApp(); const token = await login(app, evmWallet());
    await jpost(app, token, '/v1/identity/account');
    const extra = solWallet();
    // prova de posse: desafio para o endereço extra + assinatura na rede dele
    const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=solana&address=${extra.address}` })).json<{ message: string; nonce: string }>();
    const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
    const proof = { network: 'solana', address: extra.address, nonce: ch.nonce, signature: await extra.signMessage(ch.message), issuedAt, expiresAt };
    const ok = await jpost(app, token, '/v1/identity/settlement-address', proof);
    expect(ok.statusCode).toBe(201);
    expect(ok.json<IdentityView>().settlementAddresses.some(s => s.caip10.includes(extra.address))).toBe(true);
    // sem prova válida (assinatura de outra carteira) → rejeitado
    const ch2 = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=solana&address=${extra.address}` })).json<{ message: string; nonce: string }>();
    const bad = await jpost(app, token, '/v1/identity/settlement-address', { network: 'solana', address: extra.address, nonce: ch2.nonce, signature: await solWallet().signMessage(ch2.message), issuedAt: ch2.message.match(/Emitido em: (.+)/)![1]!, expiresAt: ch2.message.match(/Expira em: (.+)/)![1]! });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('gate de sessão: sem token → 403; OpenAPI 3.1 disponível', async () => {
    const { app } = await makeApp();
    expect((await app.api.inject({ method: 'GET', url: '/v1/identity/me' })).statusCode).toBe(403);
    const spec = (await app.api.inject({ method: 'GET', url: '/v1/identity/openapi.json' })).json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toContain('/v1/identity/email/start');
    await app.close();
  });
});
