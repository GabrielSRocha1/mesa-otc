/**
 * Tron como rede de liquidação (simulador local, TIP-191) + hook recordApproval da porta
 * SettlementAdapter (adapters reais submetem o passo on-chain antes da assinatura mesa).
 */
import { describe, it, expect } from 'vitest';
import { makeApp, prepareDeal, fullySign, tronWallet, ASSETS, type Parts } from './helpers.js';
import { verifyTron, tronMessageHash, testSigning } from '../src/engines/signature.js';
import { deriveNonce, statusFromTradeState, buildVerumTerms } from '../src/adapters/verum/common.js';
import { TradeState } from '../src/onchain/types.js';
import type { ApprovalSignature, SettlementAdapter, TxRef } from '../src/adapters/types.js';
import { DomainError } from '../src/domain/errors.js';

const tronParts = (): Parts => ({ SELLER: tronWallet(), BUYER: tronWallet(), PAYMASTER_1: tronWallet(), PAYMASTER_2: tronWallet() });

describe('Tron — rede de liquidação (simulador, TIP-191)', () => {
  it('deal USDT↔tBTC na Tron percorre o fluxo completo até SETTLED', async () => {
    const { app } = await makeApp(); const parts = tronParts();
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.USDT_TRON, assetOut: ASSETS.BTC_TRON, amountInBase: '50000000000' }); // 50.000 USDT
    expect(d.state).toBe('LIQUIDITY_VERIFIED');
    expect(d.onChain.tron?.registered).toBeUndefined(); // registro on-chain só no OPEN (janela de 40 min do escrow)
    const done = await fullySign(app, d.id, parts);
    expect(['SETTLEMENT_VALIDATION', 'SETTLING', 'SETTLED']).toContain(done.state);
    await app.settlement.settle(d.id).catch(() => undefined);
    expect((await app.deals.get(d.id)).state).toBe('SETTLED');
    await app.close();
  });
  it('assinatura TIP-191 de outra carteira é rejeitada', async () => {
    const { app } = await makeApp(); const parts = tronParts();
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.USDT_TRON, assetOut: ASSETS.BTC_TRON, amountInBase: '50000000000' });
    await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
    const env = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address);
    const intruder = testSigning.tron();
    const bad = intruder.sign(env.message);
    await expect(app.deals.submitSignature(d.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'secp256k1', signature: bad, nonce: env.payload.nonce }, parts.SELLER.address))
      .rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await app.close();
  });
  it('verifyTron: roundtrip positivo e negativo', () => {
    const k = testSigning.tron();
    const msg = 'VerumOTC/1/dev\n{"x":1}';
    expect(verifyTron(msg, k.sign(msg), k.address)).toBe(true);
    expect(verifyTron(msg + '!', k.sign(msg), k.address)).toBe(false);
    expect(tronMessageHash(msg)).toHaveLength(32);
  });
});

describe('ponte verum/common', () => {
  it('deriveNonce é determinístico por (deal, revisão) e muda com a revisão', () => {
    const a = deriveNonce('OTC-1', 1, 'n'); const b = deriveNonce('OTC-1', 1, 'n'); const c = deriveNonce('OTC-1', 2, 'n');
    expect(a).toBe(b); expect(a).not.toBe(c); expect(a >= 0n).toBe(true);
  });
  it('statusFromTradeState mapeia READY_TO_SETTLE→FUNDED e terminais direto', () => {
    expect(statusFromTradeState(TradeState.READY_TO_SETTLE, true, true)).toBe('FUNDED');
    expect(statusFromTradeState(TradeState.CREATED, false, false)).toBe('REGISTERED');
    expect(statusFromTradeState(TradeState.SETTLED, true, true)).toBe('SETTLED');
    expect(statusFromTradeState(TradeState.REFUNDED, false, false)).toBe('REFUNDED');
    expect(statusFromTradeState(TradeState.EXPIRED, true, false)).toBe('FUNDED');
  });
  it('buildVerumTerms rejeita legs cross-chain e exige 4 participantes', async () => {
    const { app } = await makeApp(); const parts = tronParts();
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.USDT_TRON, assetOut: ASSETS.BTC_TRON, amountInBase: '50000000000' });
    const t = d.terms!; const h = d.hash!;
    const commitment = { dealId: d.id, revision: d.revision, dealHash: h.dealHash, expiresAt: t.expiresAt, participants: t.participants, legs: t.legs, pricingHash: h.pricingHash, routeHash: h.routeHash, domainHash: h.domainHash, dealNonce: t.dealNonce, feeBps: 3, treasury: 'T', terms: t };
    const vt = buildVerumTerms(commitment, 3448148188, 'TEscrow', 1_790_000_000);
    expect(vt.expiresAt - vt.createdAt).toBe(2400);
    expect(vt.sellerAmount).toBe(50000000000n);
    const tri = { ...commitment, participants: t.participants.slice(0, 3) };
    expect(() => buildVerumTerms(tri, 3448148188, 'TEscrow', 1_790_000_000)).toThrow(DomainError);
    await app.close();
  });
});

describe('hook recordApproval (adapters reais)', () => {
  it('falha do recordApproval aborta a assinatura mesa; sucesso registra evento chain.approval', async () => {
    const calls: string[] = [];
    let failNext = false;
    const { app } = await makeApp(); const parts = tronParts();
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.USDT_TRON, assetOut: ASSETS.BTC_TRON, amountInBase: '50000000000' });
    const tron = app.adapters.require('tron') as SettlementAdapter & { recordApproval?: (id: string, s: ApprovalSignature) => Promise<TxRef | null> };
    tron.recordApproval = async (_id, sig) => {
      if (failNext) throw new DomainError('SETTLEMENT_FAILED', 'chain rejeitou');
      calls.push(sig.role);
      return { chain: 'tron', ref: 'tx-' + sig.role, submittedAt: Date.now() };
    };
    await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
    // falha on-chain → assinatura mesa NÃO é registrada
    failNext = true;
    const env = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address);
    await expect(app.deals.submitSignature(d.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'secp256k1', signature: await parts.SELLER.sign(env), nonce: env.payload.nonce }, parts.SELLER.address))
      .rejects.toMatchObject({ code: 'SETTLEMENT_FAILED' });
    expect((await app.deals.get(d.id)).validSignatures).toBe(0);
    // sucesso → assinatura registrada e hook chamado na ordem
    failNext = false;
    const env2 = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address);
    const r = await app.deals.submitSignature(d.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'secp256k1', signature: await parts.SELLER.sign(env2), nonce: env2.payload.nonce }, parts.SELLER.address);
    expect(r.count).toBe(1);
    expect(calls).toEqual(['SELLER']);
    await app.close();
  });
});
