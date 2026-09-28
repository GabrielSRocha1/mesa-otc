/** Benchmark local (sem rede): latências de assinatura, API, DB (memory vs PGlite), liquidação, eventos e 10.000 Deals. */
import { performance } from 'node:perf_hooks';
import { makeApp, prepareDeal, fullySign, signAs, solWallet, evmWallet, btcWallet, participantsOf, ASSETS, type Parts } from '../test/helpers.js';
import { SqlStore, createPgliteClient } from '../src/db/sqlStore.js';
import { verifyEvm, verifySolana, verifyBitcoin } from '../src/engines/signature.js';
import type { Role } from '../src/domain/types.js';
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(2); };
const stats = (name: string, xs: number[]) => console.log(`${name.padEnd(46)} n=${String(xs.length).padStart(5)}  p50=${pct(xs, .5).padStart(8)} ms  p95=${pct(xs, .95).padStart(8)} ms  p99=${pct(xs, .99).padStart(8)} ms`);
const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const r = await f(); return [r, performance.now() - t]; };
const parts3 = (): Parts => ({ SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() });

// 1. assinaturas
{ const { app } = await makeApp({ autoSettle: false }); const out: Record<string, number[]> = { evm: [], sol: [], btc: [] };
  for (const [k, parts] of [['evm', { SELLER: evmWallet(), BUYER: evmWallet(), PAYMASTER_1: evmWallet() }], ['sol', parts3()], ['btc', { SELLER: btcWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() }]] as [string, Parts][]) {
    const d = await prepareDeal(app, parts, k === 'evm' ? { assetIn: ASSETS.ETH, assetOut: ASSETS.USDC_ETH, amountInBase: '1000000000000000000' } : k === 'btc' ? { assetIn: ASSETS.BTC, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000' } : {});
    await app.deals.open(d.id, parts.SELLER.address); const env = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address); const sig = await parts.SELLER.sign(env);
    for (let i = 0; i < 200; i++) { const [, ms] = await time(async () => k === 'evm' ? verifyEvm(env, sig, parts.SELLER.address) : k === 'sol' ? verifySolana(env.message, sig, parts.SELLER.address) : verifyBitcoin(env.message, sig, parts.SELLER.address)); out[k]!.push(ms); } }
  stats('verificação EIP-712 secp256k1 (viem)', out.evm!); stats('verificação Ed25519 (tweetnacl)', out.sol!); stats('verificação BIP-137 secp256k1 (noble)', out.btc!); await app.close(); }
// 2. API + DB memory vs pglite
for (const mode of ['memory', 'pglite'] as const) {
  const store = mode === 'pglite' ? new SqlStore(await createPgliteClient()) : undefined; if (store) await store.init();
  const { app } = await makeApp({ autoSettle: false, ...(store ? { store } : {}) }); const create: number[] = [], prep: number[] = [], settle: number[] = [], get: number[] = [], evsLat: number[] = [];
  app.deals.events.on('deal', (ev: { at: number; payload: { _t?: number } }) => { if (ev.payload._t) evsLat.push(performance.now() - ev.payload._t); });
  const N = mode === 'pglite' ? 30 : 60;
  for (let i = 0; i < N; i++) { const parts = parts3(); const [d, ms] = await time(() => prepareDeal(app, parts)); prep.push(ms); const [, ms2] = await time(() => app.deals.get(d.id)); get.push(ms2);
    await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address); for (const r of Object.keys(parts) as Role[]) await signAs(app, d.id, r, parts[r]!);
    const [, ms3] = await time(() => app.settlement.settle(d.id)); settle.push(ms3); }
  const parts = parts3(); for (let i = 0; i < N; i++) { const [, ms] = await time(() => app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: participantsOf(parts) }, parts.SELLER.address)); create.push(ms); }
  const api: number[] = []; for (let i = 0; i < 200; i++) { const [, ms] = await time(() => app.api.inject({ method: 'GET', url: '/health' })); api.push(ms); }
  stats(`[${mode}] create (verificação de carteira+risco)`, create); stats(`[${mode}] preparo completo até LIQUIDITY_VERIFIED`, prep); stats(`[${mode}] getDeal`, get); stats(`[${mode}] settle (validação §7.3 + 1 tx simulada)`, settle); stats(`[${mode}] API GET /health (fastify inject)`, api);
  await app.close(); }
// 3. evento → assinante (SSE/WS in-process)
{ const { app } = await makeApp({ autoSettle: false }); const lat: number[] = []; app.deals.events.on('deal', (ev: { payload: { _t?: number } }) => { if (ev.payload._t) lat.push(performance.now() - ev.payload._t); });
  const parts = parts3(); const d = await prepareDeal(app, parts); for (let i = 0; i < 100; i++) await app.deals.withDeal(d.id, deal => app.deals.persist(deal, 'bench', 'system', { _t: performance.now() })); stats('evento Deal → assinante SSE/WS (in-process)', lat); await app.close(); }
// 4. 10.000 Deals: criação, listagem e varredura de expiração (memory)
{ const { app, clock } = await makeApp({ autoSettle: false }); const parts = parts3(); const t0 = performance.now();
  await Promise.all(Array.from({ length: 10_000 }, () => app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: participantsOf(parts) }, parts.SELLER.address)));
  const tCreate = performance.now() - t0; const [list, tList] = await time(() => app.store.listDeals({ participant: parts.SELLER.address })); clock.advance(3601_000); const [exp, tExp] = await time(() => app.deals.expireDue());
  console.log(`10.000 Deals: criação ${tCreate.toFixed(0)} ms (${(10_000 / tCreate * 1000).toFixed(0)} deals/s); listDeals(participante)=${list.length} em ${tList.toFixed(0)} ms; expireDue ⇒ ${exp.length} em ${tExp.toFixed(0)} ms; heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`); await app.close(); }
process.exit(0);
