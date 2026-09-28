/** Production hardening: matriz de assinaturas, expiração em massa, concorrência/dupla liquidação, disjuntor de preço, cabeçalhos, nonces. */
import { describe, it, expect } from 'vitest';
import { makeApp, prepareDeal, signAs, solWallet, participantsOf, ASSETS, type Parts } from './helpers.js';
import { SIGNING_ORDER, type Role } from '../src/domain/types.js';
import { DomainError } from '../src/domain/errors.js';
import { htlcHashOf } from '../src/engines/deal.js';
import { sha256Hex } from '../src/domain/types.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { PriceEngine, StaticPriceSource, DEFAULT_PRICE_CONFIG } from '../src/engines/price.js';

const parts3 = (): Parts => ({ SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() });
const parts4 = (): Parts => ({ ...parts3(), PAYMASTER_2: solWallet() });
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'OK'; } catch (e) { return (e as DomainError).code ?? (e as Error).message; } };

describe('13 · Matriz de assinaturas — somente N/N liquida', () => {
  for (const N of [3, 4] as const) for (let k = 0; k <= N; k++) {
    it(`${k}/${N} ⇒ ${k === N ? 'LIQUIDA' : 'NÃO liquida'}`, async () => {
      const { app } = await makeApp({ autoSettle: false }); const parts = N === 3 ? parts3() : parts4(); const roles = SIGNING_ORDER.filter(r => parts[r]); // ordem obrigatória de assinatura
      const d = await prepareDeal(app, parts); expect(d.requiredSignatures).toBe(N); await app.deals.open(d.id, parts.SELLER.address);
      await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
      for (const r of roles.slice(0, k)) await signAs(app, d.id, r, parts[r]!);
      const cur = await app.deals.get(d.id); expect(cur.validSignatures).toBe(k);
      if (k === N) { expect(cur.state).toBe('SETTLEMENT_VALIDATION'); expect((await app.settlement.settle(d.id)).status).toBe('DONE'); expect((await app.deals.get(d.id)).state).toBe('SETTLED'); }
      else { expect(cur.state).toBe('AWAITING_SIGNATURES'); expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_NOT_ALLOWED'); expect((await app.deals.get(d.id)).state).toBe('AWAITING_SIGNATURES');
        const sigs = cur.signatures.filter(s => s.status === 'valid').map(s => ({ role: s.role, signer: s.signer, scheme: s.scheme, signature: s.signature, nonce: s.nonce }));
        expect(await code(app.local!.solana.settle(d.id, 0, sigs))).toBe('SETTLEMENT_NOT_ALLOWED'); }
      await app.close();
    });
  }
});

describe('8 · Concorrência — dupla liquidação impossível', () => {
  it('100 Deals simultâneas, 3 tentativas concorrentes de settle por Deal ⇒ 1 liquidação e 1 tx por cadeia cada', async () => {
    const { app } = await makeApp({ autoSettle: false }); const t0 = Date.now();
    const deals = await Promise.all(Array.from({ length: 100 }, async () => { const parts = parts3(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address); for (const r of SIGNING_ORDER) { if (parts[r]) await signAs(app, d.id, r, parts[r]!); } return { id: d.id, parts }; }));
    const tPrep = Date.now() - t0; expect(deals.every(async d => (await app.deals.get(d.id)).state === 'SETTLEMENT_VALIDATION')).toBeTruthy();
    const t1 = Date.now(); const results = await Promise.all(deals.flatMap(d => [0, 1, 2].map(() => app.settlement.settle(d.id).then(r => r.id, e => `ERR:${(e as DomainError).code}`)))); const tSettle = Date.now() - t1;
    for (const d of deals) { const ids = new Set(results.filter(r => typeof r === 'string' && r.startsWith('ST-')).filter((_, i) => Math.floor(i / 3) === deals.indexOf(d))); expect(ids.size).toBe(1);
      const fin = await app.deals.get(d.id); expect(fin.state).toBe('SETTLED'); expect((await app.store.listDealEvents(d.id)).filter(e => e.type === 'settlement.leg.submitted')).toHaveLength(1);
      expect(app.local!.solana.balanceOf(d.parts.BUYER.address, null)).toBe(BigInt(fin.terms!.legs[0]!.amountBase)); }
    expect(results.filter(r => String(r).startsWith('ERR')).length).toBe(0);
    console.log(`[load] 100 deals: preparo+assinaturas ${tPrep} ms; 300 settles concorrentes ${tSettle} ms`); await app.close();
  }, 120_000);
  it('1.000 Deals criadas concorrentemente: ids únicos, sem conflito de versão, listagem por participante correta', async () => {
    const { app } = await makeApp({ autoSettle: false }); const t0 = Date.now(); const parts = parts3();
    const ids = await Promise.all(Array.from({ length: 1000 }, () => app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: participantsOf(parts) }, parts.SELLER.address).then(d => d.id)));
    expect(new Set(ids).size).toBe(1000); const dt = Date.now() - t0; console.log(`[load] 1000 creates concorrentes: ${dt} ms (${(dt / 1000).toFixed(1)} ms/deal)`);
    expect((await app.store.listDeals({ participant: parts.BUYER.address })).length).toBe(1000); expect((await app.store.listDeals({ participant: solWallet().address })).length).toBe(0); await app.close();
  }, 120_000);
});

describe('12 · Expiração em massa — nada liquida após expiresAt', () => {
  it('1.000 Deals expirando no mesmo instante: todas EXPIRED/REFUNDED, settle e assinatura rejeitados depois', async () => {
    const { app, clock } = await makeApp({ autoSettle: false }); const t0 = Date.now(); const all: { id: string; parts: Parts; signed: boolean }[] = [];
    for (let i = 0; i < 1000; i++) { const parts = parts3(); const d = await prepareDeal(app, parts, { amountInBase: '1000000000' }); await app.deals.open(d.id, parts.SELLER.address);
      const signed = i % 4 === 0; if (signed) { await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address); await signAs(app, d.id, 'SELLER', parts.SELLER); await signAs(app, d.id, 'PAYMASTER_1', parts.PAYMASTER_1); } all.push({ id: d.id, parts, signed }); }
    const tPrep = Date.now() - t0; clock.advance(3601_000); const t1 = Date.now(); const expired = await app.deals.expireDue(); const tExp = Date.now() - t1;
    expect(expired.length).toBe(1000);
    for (const d of all) { const fin = await app.deals.get(d.id); expect(d.signed ? 'REFUNDED' : 'EXPIRED').toBe(fin.state); if (d.signed) expect(app.local!.solana.balanceOf(d.parts.SELLER.address, null)).toBe(2000000000n); }
    for (const d of all.slice(0, 50)) { expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_NOT_ALLOWED'); expect(await code(signAs(app, d.id, 'PAYMASTER_1', d.parts.PAYMASTER_1))).toMatch(/SETTLEMENT_NOT_ALLOWED|DEAL_EXPIRED/); }
    expect((await app.deals.expireDue()).length).toBe(0); // idempotente
    console.log(`[load] 1000 deals preparadas em ${tPrep} ms; varredura de expiração ${tExp} ms`); await app.close();
  }, 180_000);
});

describe('5 · Price Engine — disjuntor, obsolescência, fonte única', () => {
  const ids = ['a', 'b']; const prices = { a: 100, b: 1 };
  it('cotação obsoleta é descartada; abaixo do mínimo de fontes ⇒ PRICE_UNAVAILABLE', async () => {
    const srcs = [new StaticPriceSource('s1', 1, prices), new StaticPriceSource('s2', 1, prices), new StaticPriceSource('s3', 1, prices)]; const t = 1_000_000; const pe = new PriceEngine(srcs, { ...DEFAULT_PRICE_CONFIG, minSources: 3 }, () => t);
    expect((await pe.quote(ids)).anomaly).toBe(false); srcs[0]!.staleAt = t - 120_000; expect(await code(pe.quote(ids))).toBe('PRICE_UNAVAILABLE'); srcs[0]!.staleAt = t - 10_000; expect((await pe.quote(ids)).sourcesOk).toBe(3);
  });
  it('anomalias repetidas abrem o disjuntor; reset só por operador; fonte única nunca é aceita', async () => {
    const srcs = [new StaticPriceSource('s1', 1, prices), new StaticPriceSource('s2', 1, prices), new StaticPriceSource('s3', 1, prices)]; let t = 1_000_000; const pe = new PriceEngine(srcs, { ...DEFAULT_PRICE_CONFIG, breaker: { threshold: 3, windowMs: 60_000, cooldownMs: 300_000 } }, () => t);
    srcs[0]!.skew = 1.05; for (let i = 0; i < 3; i++) { expect((await pe.quote(ids)).anomaly).toBe(true); t += 1000; }
    expect(pe.breakerState().open).toBe(true); srcs[0]!.skew = 1; expect(await code(pe.quote(ids))).toBe('PRICE_UNAVAILABLE');
    t += 300_001; expect((await pe.quote(ids)).anomaly).toBe(false); // cooldown vencido
    srcs[0]!.skew = 1.05; for (let i = 0; i < 3; i++) { await pe.quote(ids); t += 1000; } expect(pe.breakerState().open).toBe(true); pe.resetBreaker(); srcs[0]!.skew = 1; expect((await pe.quote(ids)).anomaly).toBe(false);
    const single = new PriceEngine([new StaticPriceSource('only', 1, prices)], DEFAULT_PRICE_CONFIG, () => t); expect(await code(single.quote(ids))).toBe('PRICE_UNAVAILABLE');
  });
  it('a Deal não avança com o disjuntor aberto', async () => {
    const { app } = await makeApp(); app.sources.price[0]!.skew = 1.05; for (let i = 0; i < 3; i++) await code(prepareDeal(app, parts3()));
    app.sources.price[0]!.skew = 1; expect(app.price.breakerState().open).toBe(true); expect(await code(prepareDeal(app, parts3()))).toBe('PRICE_UNAVAILABLE'); await app.close();
  });
});

describe('2 · Segurança — cabeçalhos, request-id, nonce vinculado à carteira, HTLC consistente', () => {
  it('respostas carregam cabeçalhos de segurança e x-request-id; CSP presente', async () => {
    const { app } = await makeApp(); const r = await app.api.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'req-abc-12345' } });
    expect(r.headers['x-request-id']).toBe('req-abc-12345'); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-frame-options']).toBeUndefined(); expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'self' https://verumcrypto.com https://*.verumcrypto.com"); expect(r.headers['cache-control']).toBe('no-store');
    const r2 = await app.api.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': '<script>' } }); expect(String(r2.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/); await app.close();
  });
  it('desafio de login emitido para A não pode ser consumido por B', async () => {
    const { app } = await makeApp(); const a = solWallet(), b = solWallet(); const ch = await app.auth.challenge('solana', a.address);
    const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
    const msgB = ch.message.replace(a.address, b.address); expect(await code(app.auth.verify('solana', b.address, ch.nonce, await b.signMessage(msgB), issuedAt, expiresAt))).toBe('NONCE_INVALID'); await app.close();
  });
  it('envelope repetido reutiliza o mesmo nonce (sem crescimento da tabela) e o hash HTLC é sobre os bytes da preimage', async () => {
    const { app } = await makeApp(); const parts = parts3(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address);
    const e1 = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address); const e2 = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address); expect(e1.payload.nonce).toBe(e2.payload.nonce);
    const pre = 'ab'.repeat(32); expect(htlcHashOf(pre)).toBe(sha256Hex(hexToBytes(pre))); expect(htlcHashOf(pre)).not.toBe(sha256Hex(pre)); await app.close();
  });
});
