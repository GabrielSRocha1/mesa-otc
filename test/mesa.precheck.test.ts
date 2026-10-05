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
});
