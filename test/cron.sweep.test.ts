/** Cron de varredura (serverless): reembolso automático de operação vencida, sem ninguém abrir o painel. */
import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, prepareDeal, solWallet, type Parts } from './helpers.js';

describe('Cron sweep · reembolso automático (serverless)', () => {
  const prev = process.env.CRON_SECRET;
  afterEach(() => { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; });

  it('secret errado → 403; secret certo → expira e reembolsa a operação financiada', async () => {
    process.env.CRON_SECRET = 'cron-test-secret';
    const { app, clock } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts);
    await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
    clock.advance(10 * 86400 * 1000); // vence a operação

    // Sem o segredo correto → bloqueado (endpoint nunca fica público).
    const bad = await app.api.inject({ method: 'GET', url: '/ops/cron/sweep', headers: { authorization: 'Bearer errado' } });
    expect(bad.statusCode).toBe(403);

    // Com o segredo do cron → varre globalmente e reembolsa, sem sessão humana.
    const ok = await app.api.inject({ method: 'GET', url: '/ops/cron/sweep', headers: { authorization: 'Bearer cron-test-secret' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const res = ok.json<{ ok: boolean; expired: number }>();
    expect(res.ok).toBe(true);
    expect(res.expired).toBeGreaterThanOrEqual(1);

    const fin = await app.deals.get(d.id);
    expect(['REFUNDING', 'REFUNDED']).toContain(fin.state);
    expect(fin.refunds.filter(r => r.status === 'REFUNDED').length).toBeGreaterThanOrEqual(2);
    await app.close();
  }, 120_000);
});
