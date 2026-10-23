/** Operar Indexado — serviço de fixing: configurar, fixar, refixar (versão++), expiração, max_move, lock, hash. */
import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';
import { AuditLog } from '../src/audit/audit.js';
import { IndexedPricingService } from '../src/indexing/service.js';
import { MockIndexProvider } from '../src/indexing/provider.js';
import type { IndexRequest, RawQuote } from '../src/indexing/types.js';
import { canonicalize } from '../src/domain/types.js';
import type { MesaChair, MesaRecord } from '../src/mesa/types.js';

const USDT = { network: 'solana', contractOrMint: 'USDTmint', decimals: 6, symbol: 'USDT' };
const USDC = { network: 'solana', contractOrMint: 'USDCmint', decimals: 6, symbol: 'USDC' };
const chair = (role: MesaChair['role'], asset: typeof USDT): MesaChair => ({ chairId: `c-${role}`, role, expectedAsset: asset, wallet: null });

function makeMesa(): MesaRecord {
  return { mesaId: 'MESA-TEST', payMasterId: 'pm-1', code: 'MESA-XXXX', network: 'solana', chairs: [chair('SELLER', USDT), chair('BUYER', USDC), chair('PAYMASTER_1', USDT)], approvals: {}, config: { amountInBase: '100000000', discountBps: 0, commissionBps: 0 }, dealId: null, dealIds: [], createdAt: 0, expiresAt: null };
}

class Clock { t = 1_000_000; now = () => this.t; }
function makeService(opts: { grossOut?: () => [bigint, bigint]; provider?: null } = {}) {
  const store = new MemoryStore(); const clock = new Clock(); const audit = new AuditLog(store, clock.now);
  const quotesFor = (req: IndexRequest): RawQuote[] => { const [a, b] = (opts.grossOut ?? (() => [req.baseAmount, req.baseAmount] as [bigint, bigint]))(); return [{ provider: 'mm-a', grossOut: a }, { provider: 'mm-b', grossOut: b }]; };
  const provider = opts.provider === null ? null : new MockIndexProvider(quotesFor, { minProviders: 2, maxDispersionBps: 100 }, clock.now);
  const svc = new IndexedPricingService({ store, audit, provider, now: clock.now, limits: { fixingTtlSec: 600 } });
  return { svc, store, clock };
}

describe('indexado · serviço: configurar + fixar', () => {
  it('configura modo INDEXED, spread e fixa valores concretos', async () => {
    const { svc, clock } = makeService();
    const mesa = makeMesa();
    const cfg = await svc.configure(mesa, { spreadBps: 100 }, 'pm-1');
    expect(cfg.mode).toBe('INDEXED_VERUM_SWAP'); expect(cfg.spreadBps).toBe(100); expect(cfg.termsVersion).toBe(1); expect(cfg.status).toBe('CONFIGURED');
    const { record, quoteAmount } = await svc.fix(mesa, {}, 'pm-1');
    expect(record.status).toBe('FIXED');
    // 1:1 (USDT↔USDC) + spread +100 bps ⇒ ~101000000 (100 USDT → 101 USDC)
    expect(quoteAmount).toBe('101000000');
    expect(record.fixingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fixingExpiresAt).toBe(clock.now() + 600_000);
  });
  it('spread fora do intervalo → INVALID_INPUT', async () => {
    const { svc } = makeService();
    await expect(svc.configure(makeMesa(), { spreadBps: 9999 }, 'pm-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('fixar sem configurar → INVALID_INPUT', async () => {
    const { svc } = makeService();
    await expect(svc.fix(makeMesa(), {}, 'pm-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('provedor ausente (prod sem motor) → INDEX_DISABLED', async () => {
    const { svc } = makeService({ provider: null });
    const mesa = makeMesa(); await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    await expect(svc.fix(mesa, {}, 'pm-1')).rejects.toMatchObject({ code: 'INDEX_DISABLED' });
  });
});

describe('indexado · refixing e max_move', () => {
  it('refix após LOCK incrementa a versão (assinaturas zeradas pelo reopen da mesa)', async () => {
    const { svc } = makeService();
    const mesa = makeMesa();
    await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    const first = await svc.fix(mesa, {}, 'pm-1');
    expect(first.record.termsVersion).toBe(1);
    // simula o que a rota faz: grava os valores na config e trava na aprovação
    mesa.config!.buyerAmountInBase = first.quoteAmount; mesa.config!.amountInBase = first.baseAmount;
    const hash = await svc.lockForApproval(mesa, 'pm-1');
    expect(hash).toBe(first.record.fixingHash);
    expect(await svc.lockForApproval(mesa, 'pm-1')).toBe(hash); // idempotente
    // refix pós-lock → nova versão
    const second = await svc.fix(mesa, {}, 'pm-1');
    expect(second.record.termsVersion).toBe(2);
    expect(second.record.status).toBe('FIXED');
  });
  it('rejeição do índice é AUDITADA (append-only) e a mesa não muda', async () => {
    // provedor devolve 1 só fonte → INDEX_UNRELIABLE
    const { svc, store } = makeService({ grossOut: () => [100_000_000n, 100_000_000n] });
    // força minProviders falhando: injeta provider com 1 fonte via quotesFor custom
    const store2 = store; void store2;
    const mesa = makeMesa(); await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    // sobrescreve: usa um provedor que lança (dispersão enorme)
    const bad = makeService({ grossOut: () => [100_000_000n, 500_000_000n] }); // ~dispersão gigante > 100 bps
    const mesaB = makeMesa(); await bad.svc.configure(mesaB, { spreadBps: 0 }, 'pm-1');
    await expect(bad.svc.fix(mesaB, {}, 'pm-1')).rejects.toMatchObject({ code: 'INDEX_UNRELIABLE' });
    const audit = await bad.store.listAudit();
    expect(audit.some(a => a.category === 'mesa.indexed.rejeitado')).toBe(true);
    expect(await bad.store.getIndexedPricing(mesaB.mesaId)).toMatchObject({ status: 'CONFIGURED', fixingHash: null });
  });
  it('desvio > max_move exige confirmação explícita', async () => {
    let factor = 10_000n; // bps
    const { svc } = makeService({ grossOut: () => { const g = (100_000_000n * factor) / 10_000n; return [g, g]; } });
    const mesa = makeMesa();
    await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    await svc.fix(mesa, {}, 'pm-1');            // fixa a 1:1
    factor = 11_000n;                           // +10% → > max_move (100 bps)
    await expect(svc.fix(mesa, {}, 'pm-1')).rejects.toMatchObject({ code: 'INDEX_MOVE_CONFIRM' });
    const ok = await svc.fix(mesa, { confirmMove: true }, 'pm-1'); // confirma
    expect(ok.record.status).toBe('FIXED');
  });
});

describe('indexado · lock e integridade', () => {
  it('lock sem fixing → INDEX_NOT_FIXED', async () => {
    const { svc } = makeService();
    const mesa = makeMesa(); await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    await expect(svc.lockForApproval(mesa, 'pm-1')).rejects.toMatchObject({ code: 'INDEX_NOT_FIXED' });
  });
  it('fixing expirado → INDEX_FIXING_EXPIRED', async () => {
    const { svc, clock } = makeService();
    const mesa = makeMesa(); await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    const f = await svc.fix(mesa, {}, 'pm-1'); mesa.config!.buyerAmountInBase = f.quoteAmount;
    clock.t += 600_001;
    await expect(svc.lockForApproval(mesa, 'pm-1')).rejects.toMatchObject({ code: 'INDEX_FIXING_EXPIRED' });
  });
  it('config divergente do fixing → INDEX_NOT_FIXED', async () => {
    const { svc } = makeService();
    const mesa = makeMesa(); await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    await svc.fix(mesa, {}, 'pm-1'); // config.buyerAmountInBase NÃO foi atualizado → divergente
    await expect(svc.lockForApproval(mesa, 'pm-1')).rejects.toMatchObject({ code: 'INDEX_NOT_FIXED' });
  });
  it('FIXED (sem modo indexado) → lock devolve null (nada a travar)', async () => {
    const { svc } = makeService();
    expect(await svc.lockForApproval(makeMesa(), 'pm-1')).toBeNull();
  });
  it('remover volta a FIXED antes do lock; depois do lock bloqueia', async () => {
    const { svc } = makeService();
    const mesa = makeMesa(); await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    const f = await svc.fix(mesa, {}, 'pm-1'); mesa.config!.buyerAmountInBase = f.quoteAmount;
    await svc.remove(mesa, 'pm-1');
    expect(await svc.get(mesa.mesaId)).toBeNull();
    // re-fixa e trava → remover agora bloqueia
    await svc.configure(mesa, { spreadBps: 0 }, 'pm-1');
    const f2 = await svc.fix(mesa, {}, 'pm-1'); mesa.config!.buyerAmountInBase = f2.quoteAmount;
    await svc.lockForApproval(mesa, 'pm-1');
    await expect(svc.remove(mesa, 'pm-1')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

describe('indexado · fixing_hash', () => {
  it('muda se qualquer campo mudar (ex.: spread)', async () => {
    const a = makeService(); const mesaA = makeMesa(); await a.svc.configure(mesaA, { spreadBps: 100 }, 'pm-1'); const fa = await a.svc.fix(mesaA, {}, 'pm-1');
    const b = makeService(); const mesaB = makeMesa(); await b.svc.configure(mesaB, { spreadBps: 200 }, 'pm-1'); const fb = await b.svc.fix(mesaB, {}, 'pm-1');
    expect(fa.record.fixingHash).not.toBe(fb.record.fixingHash);
  });
  it('é determinístico para os mesmos insumos', async () => {
    const a = makeService(); const mesaA = makeMesa(); await a.svc.configure(mesaA, { spreadBps: 100 }, 'pm-1'); const fa = await a.svc.fix(mesaA, {}, 'pm-1');
    const b = makeService(); const mesaB = makeMesa(); await b.svc.configure(mesaB, { spreadBps: 100 }, 'pm-1'); const fb = await b.svc.fix(mesaB, {}, 'pm-1');
    expect(fa.record.fixingHash).toBe(fb.record.fixingHash);
  });
  it('REGRESSÃO: indexedFixingHash ausente/undefined não muda o hash dos termos (FIXED byte-idêntico)', () => {
    const pricing = { referencePriceInUsd: '1', discountBps: 0 };
    expect(canonicalize({ ...pricing, indexedFixingHash: undefined })).toBe(canonicalize(pricing));
    expect(canonicalize({ ...pricing, indexedFixingHash: 'abc' })).not.toBe(canonicalize(pricing));
  });
});
