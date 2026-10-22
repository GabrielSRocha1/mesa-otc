/**
 * balancePreCheck + trava de irrevogabilidade: todos veem os saldos das duas pernas antes de
 * sacramentar; com a leg de contrato financiada, "Cancelar mesa" morre no backend (409).
 */
import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers.js';
import type { Deal } from '../src/domain/types.js';

const pmHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;

async function mesaComToken(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail('pre'), password: 'senha-forte-1' } });
  const token = r.json<{ token: string }>().token;
  const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { network: 'tron', chairs: [
    { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
    { role: 'BUYER', expectedAsset: { network: 'tron', contractOrMint: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' } },
  ] } })).json<{ mesaId: string }>();
  return { token, mesaId: mesa.mesaId };
}

/** Deal mínima para a trava (só os campos que isIrreversible/getDeal usam). */
const fakeDeal = (state: string, funding: 'PENDING' | 'FINAL'): Deal => ({
  id: 'OTC-fake-1', state, revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 3600_000, version: 1,
  requiredSignatures: 2, validSignatures: 0, signatures: [],
  participants: [
    { role: 'SELLER', address: 'addr1', fundingRequired: true, funding },
    { role: 'BUYER', address: 'addr2', fundingRequired: true, funding: 'PENDING' },
  ],
} as unknown as Deal);

describe('balancePreCheck — rota e gate de assinatura', () => {
  it('GET /precheck devolve saldos por cadeira + canCancel/irreversible (mesa recém-criada cancela)', async () => {
    const { app } = await makeApp({});
    const { token, mesaId } = await mesaComToken(app);
    const r = await app.api.inject({ method: 'GET', url: `/v1/portal/mesas/${mesaId}/precheck`, headers: pmHeaders(token) });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json<{ ok: boolean; failures: string[]; irreversible: boolean; canCancel: boolean }>();
    expect(body.irreversible).toBe(false);
    expect(body.canCancel).toBe(true);
    expect(body.ok).toBe(false); // cadeiras ainda sem carteira → motivos nominais
    expect(body.failures.join(' | ')).toContain('carteira ainda não conectada');

    // Lista multichain TOLERANTE: entrada malformada da wallet é descartada, nunca "Entrada inválida".
    const wc = await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: pmHeaders(token), payload: { address: 'FCK3dJUrJvG9WZhVsrQYVgzLzWxCpqmS27WNksavX41n', network: 'solana', addresses: [
      { network: 'solana', address: 'FCK3dJUrJvG9WZhVsrQYVgzLzWxCpqmS27WNksavX41n' },
      { network: 'xrp', address: '' },           // malformada (vazia) → descartada
      { network: 'x', address: 'abcdefgh1234' }, // rede curta demais → descartada
      null,                                       // lixo → descartado
    ] } });
    expect(wc.statusCode, wc.body).toBe(200);

    // Link do convite usa o HOST da requisição (deploy/local) — nunca o domínio fixo da config.
    const mesa = app.mesa.mesaById(mesaId)!;
    const buyerChair = mesa.chairs.find(c => c.role === 'BUYER')!;
    const inv = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${buyerChair.chairId}/invite`, headers: { ...pmHeaders(token), host: 'meu-deploy.vercel.app', 'x-forwarded-proto': 'https' }, payload: {} });
    expect(inv.statusCode, inv.body).toBe(201);
    expect(inv.json<{ link: string }>().link.startsWith('https://meu-deploy.vercel.app/otc/convite/')).toBe(true);
    await app.close();
  }, 60_000);

  it('isIrreversible: financiamento FINAL ou coleta concluída travam; pendente não trava', async () => {
    const { app } = await makeApp({});
    expect(app.mesa.isIrreversible(null)).toBe(false);
    expect(app.mesa.isIrreversible(fakeDeal('AWAITING_SIGNATURES', 'PENDING'))).toBe(false);
    expect(app.mesa.isIrreversible(fakeDeal('AWAITING_SIGNATURES', 'FINAL'))).toBe(true);
    expect(app.mesa.isIrreversible(fakeDeal('FULLY_SIGNED', 'PENDING'))).toBe(true);
    expect(app.mesa.isIrreversible(fakeDeal('SETTLING', 'PENDING'))).toBe(true);
    await app.close();
  }, 60_000);

  it('cancelar mesa com leg de contrato financiada → 409 e a mesa segue viva (irreversível)', async () => {
    const { app } = await makeApp({});
    const { token, mesaId } = await mesaComToken(app);
    // Simula a operação em andamento com o USDT do comprador... do vendedor trancado: deal no store + vínculo na mesa.
    const deal = fakeDeal('AWAITING_SIGNATURES', 'FINAL');
    await app.store.insertDeal(deal);
    const mesa = app.mesa.mesaById(mesaId);
    expect(mesa).not.toBeNull();
    app.mesa.attachDeal(mesa!, deal.id);
    const cancel = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/cancel`, headers: pmHeaders(token), payload: { reason: 'tentativa' } });
    expect(cancel.statusCode, cancel.body).toBe(409);
    expect(cancel.json<{ message: string }>().message).toContain('irreversível');
    // DTO reflete a trava para o frontend esconder o botão.
    const view = (await app.api.inject({ method: 'GET', url: `/v1/portal/mesas/${mesaId}`, headers: pmHeaders(token) })).json<{ irreversible: boolean; canCancel: boolean; cancelled: unknown }>();
    expect(view.irreversible).toBe(true);
    expect(view.canCancel).toBe(false);
    expect(view.cancelled).toBeNull();
    await app.close();
  }, 60_000);

  it('antes do financiamento o cancelamento continua funcionando', async () => {
    const { app } = await makeApp({});
    const { token, mesaId } = await mesaComToken(app);
    const cancel = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/cancel`, headers: pmHeaders(token), payload: { reason: 'mudei de ideia' } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    await app.close();
  }, 60_000);

  it('exigência do COMPRADOR vem da perna do deal (ETH), não só do gás: comprador com gás mas sem ETH suficiente é barrado', async () => {
    // Leitores mock: 0,01 ETH na conta (gás US$ 20 → passa), mas a perna do comprador pede 0,034 ETH.
    const readers = {
      native: async () => ({ amount: 0.01 }),
      tokens: async () => [],
      priceUsdOf: async () => 2000,
      tokenDirect: async () => null,
    };
    const { app } = await makeApp({ balanceReaders: readers as never });
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail('buyeramt'), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const mesaId = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { network: 'ethereum', chairs: [
      { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
    ] } })).json<{ mesaId: string }>().mesaId;
    // Conecta carteiras direto nas cadeiras (simula o join multichain).
    const mesa = app.mesa.mesaById(mesaId)!;
    mesa.chairs.find(c => c.role === 'SELLER')!.wallet = { network: 'bitcoin', address: 'tb1qseller', addresses: [{ network: 'bitcoin', address: 'tb1qseller' }] } as never;
    mesa.chairs.find(c => c.role === 'BUYER')!.wallet = { network: 'ethereum', address: '0x1111111111111111111111111111111111111111', addresses: [{ network: 'ethereum', address: '0x1111111111111111111111111111111111111111' }] } as never;
    // Deal vinculado com a perna do COMPRADOR exigindo 0,034 ETH; VENDEDOR já FINAL (dispensado).
    const deal = {
      id: 'OTC-buyeramt-1', state: 'AWAITING_SIGNATURES', revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 3600_000, version: 1,
      requiredSignatures: 2, validSignatures: 0, signatures: [],
      participants: [
        { role: 'SELLER', address: 'tb1qseller', fundingRequired: true, funding: 'FINAL' },
        { role: 'BUYER', address: '0x1111111111111111111111111111111111111111', fundingRequired: true, funding: 'PENDING' },
      ],
      terms: { legs: [
        { index: 0, from: 'SELLER', to: 'BUYER', asset: { network: 'bitcoin', contractOrMint: null, decimals: 8 }, amountBase: '20000', escrowChain: 'bitcoin', mode: 'HTLC' },
        { index: 1, from: 'BUYER', to: 'SELLER', asset: { network: 'ethereum', contractOrMint: null, decimals: 18 }, amountBase: '34000000000000000', escrowChain: 'ethereum', mode: 'escrow' },
      ] },
    } as unknown as Deal;
    await app.store.insertDeal(deal);
    app.mesa.attachDeal(mesa, deal.id);
    const body = (await app.api.inject({ method: 'GET', url: `/v1/portal/mesas/${mesaId}/precheck`, headers: pmHeaders(token) })).json<{ ok: boolean; failures: string[] }>();
    expect(body.ok).toBe(false);
    expect(body.failures.join(' | ')).toMatch(/Comprador: saldo de ETH insuficiente/);
    await app.close();
  }, 60_000);
});
