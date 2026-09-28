/**
 * Propostas estruturadas de alteração de termos (VERUM OTC §5.3/§6).
 * Prova: mudança tipada valida; aplicar invalida TODAS as assinaturas (superseded) e volta a
 * AWAITING_SIGNATURES com version++; só o criador aplica; proposta obsoleta é rejeitada;
 * assinatura da revisão antiga não conta (anti-replay entre versões).
 */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, prepareDeal, signAs, type Parts } from './helpers.js';
import type { App } from '../src/app.js';
import type { Wallet } from './helpers.js';

async function login(app: App, w: Wallet): Promise<string> {
  const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=${w.network}&address=${w.address}` })).json<{ message: string; nonce: string }>();
  const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
  return (await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: w.network, address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } })).json<{ token: string }>().token;
}
let k = 0;
const P = (app: App, token: string, url: string, payload?: Record<string, unknown>) => app.api.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': `p-${Date.now()}-${k++}` }, payload });

describe('§6 Propostas — aplicar invalida assinaturas e volta a AWAITING_SIGNATURES', () => {
  it('assinatura da revisão anterior é invalidada; version++; só o criador aplica', async () => {
    const { app } = await makeApp();
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const deal = await prepareDeal(app, parts);
    await app.deals.open(deal.id, parts.SELLER.address);
    await app.deals.fund(deal.id, 'SELLER', parts.SELLER.address);
    await app.deals.fund(deal.id, 'BUYER', parts.BUYER.address);
    await signAs(app, deal.id, 'SELLER', parts.SELLER); // 1 assinatura válida na revisão 1
    expect((await app.deals.get(deal.id)).validSignatures).toBe(1);

    // Comprador propõe; preview aponta 1 assinatura a invalidar.
    const { proposal, preview } = await app.proposals.propose(deal.id, parts.BUYER.address, { type: 'discount', discountBps: 250 });
    expect(preview.signaturesToInvalidate).toBe(1); expect(preview.nextRevision).toBe(2);

    // Só o criador (Vendedor) aplica — Comprador é rejeitado.
    await expect(app.proposals.apply(deal.id, proposal.id, parts.BUYER.address)).rejects.toThrow();
    const reopened = await app.proposals.apply(deal.id, proposal.id, parts.SELLER.address);
    expect(reopened.revision).toBe(2);
    expect(reopened.validSignatures).toBe(0);
    expect(reopened.state).toBe('AWAITING_SIGNATURES');
    expect(reopened.draft.discountBps).toBe(250);
    // A assinatura da revisão 1 ficou superseded (anti-replay entre versões).
    const d2 = await app.deals.get(deal.id);
    expect(d2.signatures.filter(s => s.revision === 1).every(s => s.status === 'superseded')).toBe(true);
    // Reassinatura na revisão 2 volta a contar.
    await app.deals.fund(deal.id, 'SELLER', parts.SELLER.address);
    await app.deals.fund(deal.id, 'BUYER', parts.BUYER.address);
    await signAs(app, deal.id, 'SELLER', parts.SELLER);
    expect((await app.deals.get(deal.id)).validSignatures).toBe(1);
    await app.close();
  });

  it('não-participante não propõe; proposta obsoleta (revisão antiga) é rejeitada', async () => {
    const { app } = await makeApp();
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const deal = await prepareDeal(app, parts);
    await expect(app.proposals.propose(deal.id, solWallet().address, { type: 'discount', discountBps: 100 })).rejects.toThrow(/participantes/);
    // Duas propostas na revisão 1; aplicar uma torna a outra obsoleta.
    const p1 = (await app.proposals.propose(deal.id, parts.SELLER.address, { type: 'discount', discountBps: 300 })).proposal;
    const p2 = (await app.proposals.propose(deal.id, parts.BUYER.address, { type: 'expiry', expiresInSec: 7200 })).proposal;
    await app.proposals.apply(deal.id, p1.id, parts.SELLER.address); // revisão → 2
    await expect(app.proposals.apply(deal.id, p2.id, parts.SELLER.address)).rejects.toThrow(/obsoleta|revisão antiga|stale|não está aberta/);
    await app.close();
  });
});

describe('§5.3 Propostas — estruturadas (nunca texto livre) via HTTP', () => {
  it('validação de mudança + autorização das rotas', async () => {
    const { app } = await makeApp();
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const deal = await prepareDeal(app, parts); // LIQUIDITY_VERIFIED (alterável)
    const seller = await login(app, parts.SELLER); const buyer = await login(app, parts.BUYER); const stranger = await login(app, solWallet());

    // Mudança fora dos limites e texto livre são rejeitados (400).
    expect((await P(app, seller, `/v1/deals/${deal.id}/proposals`, { type: 'discount', discountBps: 99999 })).statusCode).toBe(400);
    expect((await P(app, seller, `/v1/deals/${deal.id}/proposals`, { type: 'inexistente', foo: 'bar' })).statusCode).toBe(400);
    expect((await P(app, seller, `/v1/deals/${deal.id}/proposals`, { livre: 'quero mudar tudo' })).statusCode).toBe(400);
    // Não-participante não propõe (403).
    expect((await P(app, stranger, `/v1/deals/${deal.id}/proposals`, { type: 'discount', discountBps: 200 })).statusCode).toBe(403);

    // Participante propõe (201); só o criador aplica.
    const created = await P(app, buyer, `/v1/deals/${deal.id}/proposals`, { type: 'discount', discountBps: 200 });
    expect(created.statusCode).toBe(201);
    const pid = created.json<{ proposal: { id: string } }>().proposal.id;
    expect((await P(app, buyer, `/v1/deals/${deal.id}/proposals/${pid}/apply`)).statusCode).toBe(403); // não é o criador
    const applied = await P(app, seller, `/v1/deals/${deal.id}/proposals/${pid}/apply`);
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ revision: number; state: string }>().revision).toBe(2);
    expect(applied.json<{ state: string }>().state).toBe('AWAITING_SIGNATURES');
    await app.close();
  });
});
