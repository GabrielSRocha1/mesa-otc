/** Operar Indexado — fonte do índice: validação (mediana/dispersão/minProviders) e robustez de rede. */
import { describe, it, expect } from 'vitest';
import { buildSnapshot, MockIndexProvider, VerumSwapIndexProvider } from '../src/indexing/provider.js';
import type { IndexRequest, RawQuote } from '../src/indexing/types.js';
import { DomainError } from '../src/domain/errors.js';

const REQ: IndexRequest = {
  baseAsset: { network: 'solana', chainId: null, contractOrMint: 'USDT', decimals: 6, symbol: 'USDT' },
  quoteAsset: { network: 'solana', chainId: null, contractOrMint: 'USDC', decimals: 6, symbol: 'USDC' },
  baseAmount: 1_000_000n, maxAgeMs: 600_000,
};
const POLICY = { minProviders: 2, maxDispersionBps: 100 };
const q = (provider: string, grossOut: bigint, extra: Partial<RawQuote> = {}): RawQuote => ({ provider, grossOut, ...extra });
const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof DomainError ? e.code : 'OTHER'; } };

describe('indexado · buildSnapshot (validação de confiabilidade)', () => {
  it('mediana de fontes válidas', () => {
    const s = buildSnapshot(REQ, [q('a', 999_000n), q('b', 1_000_000n), q('c', 1_001_000n)], POLICY, 1_000);
    expect(s.sources).toHaveLength(3);
    expect(s.observedAt).toBe(1_000);
    expect(s.priceE18).toBe(1_000_000_000_000_000_000n); // 1:1
  });
  it('minProviders não atingido → INDEX_UNRELIABLE', () => {
    expect(code(() => buildSnapshot(REQ, [q('a', 1_000_000n)], POLICY, 1_000))).toBe('INDEX_UNRELIABLE');
  });
  it('dispersão acima do limite → INDEX_UNRELIABLE', () => {
    // 1_000_000 vs 1_050_000 ⇒ ~500 bps > 100
    expect(code(() => buildSnapshot(REQ, [q('a', 1_000_000n), q('b', 1_050_000n)], POLICY, 1_000))).toBe('INDEX_UNRELIABLE');
  });
  it('sem rota (lista vazia) → INDEX_NO_ROUTE', () => {
    expect(code(() => buildSnapshot(REQ, [], POLICY, 1_000))).toBe('INDEX_NO_ROUTE');
  });
  it('todas vencidas/zeradas → INDEX_NO_QUOTE', () => {
    expect(code(() => buildSnapshot(REQ, [q('a', 1_000_000n, { expiresAt: 500 }), q('b', 1_000_000n, { expiresAt: 400 })], POLICY, 1_000))).toBe('INDEX_NO_QUOTE');
  });
});

describe('indexado · MockIndexProvider', () => {
  it('staticUsd sintetiza 2 fontes dentro da dispersão', async () => {
    const p = MockIndexProvider.staticUsd({ USDT: 1, USDC: 1 }, POLICY, () => 1_000);
    const s = await p.snapshot(REQ);
    expect(s.sources.length).toBe(2);
    expect(s.dispersionBps <= 100n).toBe(true);
  });
  it('par sem preço no mapa → INDEX_NO_ROUTE', async () => {
    const p = MockIndexProvider.staticUsd({ USDT: 1 }, POLICY, () => 1_000);
    await expect(p.snapshot(REQ)).rejects.toMatchObject({ code: 'INDEX_NO_ROUTE' });
  });
});

describe('indexado · VerumSwapIndexProvider (robustez de rede)', () => {
  const cfg = { baseUrl: 'https://swap.example', apiKey: 'k', timeoutMs: 50, minProviders: 2, maxDispersionBps: 100 };
  const ok = (quotes: unknown) => (async () => new Response(JSON.stringify(quotes), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('lê cotações válidas e devolve snapshot', async () => {
    const p = new VerumSwapIndexProvider(cfg, ok([{ provider: 'mm1', grossOut: '1000000' }, { provider: 'mm2', grossOut: '1000500' }]), () => 1_000);
    const s = await p.snapshot(REQ);
    expect(s.sources).toHaveLength(2);
  });
  it('HTTP 500 → INDEX_UNRELIABLE (não derruba)', async () => {
    const f = (async () => new Response('erro', { status: 500 })) as unknown as typeof fetch;
    await expect(new VerumSwapIndexProvider(cfg, f).snapshot(REQ)).rejects.toMatchObject({ code: 'INDEX_UNRELIABLE' });
  });
  it('JSON inválido → INDEX_UNRELIABLE', async () => {
    const f = (async () => new Response('isto não é json', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(new VerumSwapIndexProvider(cfg, f).snapshot(REQ)).rejects.toMatchObject({ code: 'INDEX_UNRELIABLE' });
  });
  it('formato inesperado (não-lista) → INDEX_UNRELIABLE', async () => {
    const p = new VerumSwapIndexProvider(cfg, ok({ hello: 'world' }));
    await expect(p.snapshot(REQ)).rejects.toMatchObject({ code: 'INDEX_UNRELIABLE' });
  });
  it('timeout/abort → INDEX_UNRELIABLE', async () => {
    const f = ((_u: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })) as unknown as typeof fetch;
    await expect(new VerumSwapIndexProvider(cfg, f).snapshot(REQ)).rejects.toMatchObject({ code: 'INDEX_UNRELIABLE' });
  });
  it('itens malformados são descartados sem quebrar (mas podem cair em minProviders)', async () => {
    const p = new VerumSwapIndexProvider(cfg, ok([{ provider: 'mm1', grossOut: '1000000' }, { grossOut: 'xyz' }, { provider: 'mm2' }]));
    await expect(p.snapshot(REQ)).rejects.toMatchObject({ code: 'INDEX_UNRELIABLE' }); // só 1 válida < minProviders
  });

  it('tolera invólucros e nomes de campo alternativos do motor', async () => {
    // lista sob {data:{quotes}}, grossOut como "amountOut"/"toAmount", provider como "dex"/"source", number inteiro
    const p = new VerumSwapIndexProvider(cfg, ok({ data: { quotes: [
      { dex: 'uni', amountOut: '1000000', id: 'q1', expiry: 9999999999 },      // expiry em SEGUNDOS
      { source: 'curve', toAmount: 1000500, routeId: 'q2' },                   // number inteiro
    ] } }));
    const s = await p.snapshot(REQ);
    expect(s.sources).toHaveLength(2);
    expect(s.sources.map(x => x.provider).sort()).toEqual(['curve', 'uni']);
  });
  it('grossOut aninhado em {amount} e sem provider (numera a fonte)', async () => {
    const p = new VerumSwapIndexProvider(cfg, ok({ results: [
      { out: { amount: '1000000' } }, { out: { amount: '1000400' } },
    ] }));
    const s = await p.snapshot(REQ);
    expect(s.sources).toHaveLength(2); // provider ausente → rotulado src-1/src-2, cotações mantidas
  });
  it('fração em grossOut é rejeitada (unidades mínimas são inteiras)', async () => {
    const p = new VerumSwapIndexProvider(cfg, ok([{ provider: 'a', grossOut: '1000000.5' }, { provider: 'b', grossOut: '1000000' }]));
    await expect(p.snapshot(REQ)).rejects.toMatchObject({ code: 'INDEX_UNRELIABLE' }); // só 1 inteira válida < minProviders
  });
});
