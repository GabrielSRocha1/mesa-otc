import { describe, it, expect } from 'vitest';
import { makeApp, evmWallet, solWallet, participantsOf, ASSETS, type Parts } from './helpers.js';
import type { App } from '../src/app.js';
import type { Wallet } from './helpers.js';

async function login(app: App, w: Wallet): Promise<string> {
  const ch = await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=${w.network}&address=${w.address}` }); expect(ch.statusCode).toBe(200);
  const c = ch.json<{ message: string; nonce: string; expiresAt: number }>(); const signature = await w.signMessage(c.message);
  const issuedAt = c.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = c.message.match(/Expira em: (.+)/)![1]!;
  const v = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: w.network, address: w.address, nonce: c.nonce, signature, issuedAt, expiresAt } }); expect(v.statusCode).toBe(200);
  return v.json<{ token: string }>().token;
}
let n = 0; const key = () => `idem-${Date.now()}-${n++}`;
const post = (app: App, token: string, url: string, payload?: Record<string, unknown>, k = key()) => app.api.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': k }, payload });
const get = (app: App, token: string, url: string) => app.api.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe('API — autenticação por carteira', () => {
  it('challenge/verify com EVM (EIP-191) e Solana (Ed25519); assinatura errada e nonce reutilizado são rejeitados', async () => {
    const { app } = await makeApp(); const w = evmWallet(); const token = await login(app, w);
    const me = await get(app, token, '/v1/me'); expect(me.statusCode).toBe(200); expect(me.json<{ address: string }>().address).toBe(w.address);
    const s = solWallet(); expect((await login(app, s)).length).toBeGreaterThan(20);
    const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=ethereum&address=${w.address}` })).json<{ message: string; nonce: string }>();
    const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
    const bad = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: 'ethereum', address: w.address, nonce: ch.nonce, signature: await evmWallet().signMessage(ch.message), issuedAt, expiresAt } }); expect(bad.statusCode).toBe(400); expect(bad.json<{ error: string }>().error).toBe('SIGNATURE_INVALID');
    const ok = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: 'ethereum', address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } }); expect(ok.statusCode).toBe(200);
    const replay = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: 'ethereum', address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } }); expect(replay.statusCode).toBe(400);
    expect((await app.api.inject({ method: 'GET', url: '/v1/deals' })).statusCode).toBe(403);
    expect((await app.api.inject({ method: 'GET', url: '/v1/deals', headers: { authorization: 'Bearer abc.def' } })).statusCode).toBe(403);
    await app.close();
  });
});

describe('API — fluxo end-to-end (3 carteiras Solana) com SSE, idempotência e liquidação', async () => {
  it('cria → conecta → congela termos → deposita → assina 3/3 → liquida; recibo verificável', async () => {
    const { app } = await makeApp(); const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    app.local!.solana.mint(parts.SELLER.address, null, 10n ** 12n); app.local!.solana.mint(parts.BUYER.address, ASSETS.USDC_SOL.contractOrMint, 10n ** 12n);
    const tok = { SELLER: await login(app, parts.SELLER), BUYER: await login(app, parts.BUYER), PAYMASTER_1: await login(app, parts.PAYMASTER_1) };
    const assets = await get(app, tok.SELLER, '/v1/assets'); expect(assets.statusCode).toBe(200); expect(assets.json<unknown[]>().length).toBeGreaterThan(5);
    const body = { assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '250000000000', discountBps: 100, participants: participantsOf(parts) };
    const k = key(); const c1 = await post(app, tok.SELLER, '/v1/deals', body, k); expect(c1.statusCode).toBe(201); const deal = c1.json<{ id: string; state: string; requiredSignatures: number }>(); expect(deal.state).toBe('CREATED'); expect(deal.requiredSignatures).toBe(3);
    const c2 = await post(app, tok.SELLER, '/v1/deals', body, k); expect(c2.statusCode).toBe(201); expect(c2.json<{ id: string }>().id).toBe(deal.id); expect(c2.headers['idempotent-replayed']).toBe('true');
    const c3 = await post(app, tok.SELLER, '/v1/deals', { ...body, discountBps: 200 }, k); expect(c3.statusCode).toBe(409);
    expect((await post(app, tok.SELLER, '/v1/deals', body)).statusCode).toBe(201); // nova chave ⇒ nova Deal
    expect((await app.api.inject({ method: 'POST', url: '/v1/deals', headers: { authorization: `Bearer ${tok.SELLER}` }, payload: body })).statusCode).toBe(400); // sem Idempotency-Key
    expect((await get(app, await login(app, solWallet()), `/v1/deals/${deal.id}`)).statusCode).toBe(403); // não participante
    for (const r of ['BUYER', 'PAYMASTER_1'] as const) expect((await post(app, tok[r], `/v1/deals/${deal.id}/participants/${r}/bind`)).statusCode).toBe(200);
    let v = (await get(app, tok.SELLER, `/v1/deals/${deal.id}`)).json<{ state: string; hash: { dealHash: string }; terms: unknown; myRole: string }>(); expect(v.state).toBe('LIQUIDITY_VERIFIED'); expect(v.hash.dealHash).toHaveLength(64); expect(v.myRole).toBe('SELLER');
    expect((await post(app, tok.BUYER, `/v1/deals/${deal.id}/open`)).statusCode).toBe(403); expect((await post(app, tok.SELLER, `/v1/deals/${deal.id}/open`)).statusCode).toBe(200);
    expect((await post(app, tok.SELLER, `/v1/deals/${deal.id}/legs/0/deposit`)).statusCode).toBe(200); expect((await post(app, tok.BUYER, `/v1/deals/${deal.id}/legs/1/deposit`)).statusCode).toBe(200);
    expect((await post(app, tok.SELLER, `/v1/deals/${deal.id}/legs/1/deposit`)).statusCode).toBe(403); // leg do comprador
    for (const r of ['SELLER', 'PAYMASTER_1', 'BUYER'] as const) { // ordem obrigatória: Vendedor → PM1 → Comprador
      const env = (await get(app, tok[r], `/v1/deals/${deal.id}/approval-envelope`)).json<{ message: string; payload: { nonce: string; dealHash: string; role: string } }>(); expect(env.payload.role).toBe(r); expect(env.payload.dealHash).toBe(v.hash.dealHash);
      const signature = await parts[r].signMessage(env.message); const a = await post(app, tok[r], `/v1/deals/${deal.id}/approvals`, { role: r, signature, nonce: env.payload.nonce }); expect(a.statusCode).toBe(200);
    }
    for (let i = 0; i < 100; i++) { v = (await get(app, tok.SELLER, `/v1/deals/${deal.id}`)).json(); if (v.state === 'SETTLED') break; await new Promise(res => setTimeout(res, 20)); }
    expect(v.state).toBe('SETTLED');
    const rc = (await get(app, tok.PAYMASTER_1, `/v1/deals/${deal.id}/receipt`)).json<{ dealHash: string; settlement: { status: string }; events: unknown[] }>(); expect(rc.settlement.status).toBe('DONE'); expect(rc.events.length).toBeGreaterThan(10);
    const list = (await get(app, tok.BUYER, '/v1/deals')).json<{ id: string }[]>(); expect(list.some(d => d.id === deal.id)).toBe(true);
    expect((await get(app, tok.SELLER, '/ops/deals')).statusCode).toBe(403);
    expect((await app.api.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200); expect((await app.api.inject({ method: 'GET', url: '/metrics' })).body).toContain('otc_settlements_total');
    await app.close();
  });
  it('operador: bloquear Deal e verificar cadeia de auditoria; assinatura na API com papel errado é 403', async () => {
    const op = evmWallet(); const { app } = await makeApp({ env: { OPERATOR_ADDRESSES: op.address } }); const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    app.local!.solana.mint(parts.SELLER.address, null, 10n ** 12n); const tok = await login(app, parts.SELLER); const opTok = await login(app, op);
    const d = (await post(app, tok, '/v1/deals', { assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '250000000000', participants: participantsOf(parts) })).json<{ id: string }>();
    const b = await post(app, opTok, `/ops/deals/${d.id}/block`, { reason: 'Revisão manual de compliance' }); expect(b.statusCode).toBe(200); expect(b.json<{ state: string }>().state).toBe('BLOCKED');
    const audit = (await get(app, opTok, '/ops/audit/verify')).json<{ ok: boolean; count: number }>(); expect(audit.ok).toBe(true); expect(audit.count).toBeGreaterThan(3);
    expect((await post(app, tok, `/v1/deals/${d.id}/approvals`, { role: 'BUYER', signature: 'x'.repeat(40), nonce: 'n'.repeat(16) })).statusCode).toBe(403); // carteira não é a do papel BUYER
    await app.close();
  });
  it('rate limit devolve 429 acima do limite', async () => {
    const { app } = await makeApp({ env: { OTC_ENV: 'testnet' } }); let last = 200; for (let i = 0; i < 130; i++) { last = (await app.api.inject({ method: 'GET', url: '/health' })).statusCode; if (last === 429) break; } expect(last).toBe(429); await app.close();
  });
});
