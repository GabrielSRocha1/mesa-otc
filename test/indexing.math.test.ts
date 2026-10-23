/** Operar Indexado — matemática do fixing (bigint puro, sem rede). Mediana, spread, resíduo, decimais, uint256. */
import { describe, it, expect } from 'vitest';
import { medianBigint, dispersionBps, impliedPriceE18, applySpreadE18, computeQuoteAmount, E18, UINT256_MAX } from '../src/indexing/math.js';

describe('indexado · mediana bigint', () => {
  it('2, 3 e 5 fontes', () => {
    expect(medianBigint([10n])).toBe(10n);
    expect(medianBigint([10n, 20n])).toBe(15n);            // par → média (floor) dos dois centrais
    expect(medianBigint([30n, 10n, 20n])).toBe(20n);
    expect(medianBigint([50n, 10n, 30n, 20n, 40n])).toBe(30n);
    expect(medianBigint([10n, 20n, 30n, 40n])).toBe(25n);  // (20+30)/2
  });
  it('média de par ímpar arredonda para baixo', () => { expect(medianBigint([10n, 21n])).toBe(15n); });
  it('lista vazia lança', () => { expect(() => medianBigint([])).toThrow(); });
});

describe('indexado · dispersão', () => {
  it('(max − min) / mediana em bps', () => { expect(dispersionBps([99n, 100n, 101n])).toBe(200n); });
  it('zero quando todas iguais', () => { expect(dispersionBps([100n, 100n])).toBe(0n); });
});

describe('indexado · preço implícito (decimais)', () => {
  it('USDT(6)→USDC(6) 1:1 ⇒ 1e18', () => {
    expect(impliedPriceE18(1_000_000n, 1_000_000n, 6, 6)).toBe(E18);
  });
  it('BTC(8)→USDT(6) a 64000 ⇒ 64000·1e18', () => {
    // 1 BTC (1e8) rende 64000 USDT (64000·1e6 em 6 casas)
    expect(impliedPriceE18(64_000n * 1_000_000n, 100_000_000n, 8, 6)).toBe(64_000n * E18);
  });
  it('SOL(9)→USDC(6) a 150 ⇒ 150·1e18', () => {
    expect(impliedPriceE18(150n * 1_000_000n, 1_000_000_000n, 9, 6)).toBe(150n * E18);
  });
  it('baseAmount zero lança', () => { expect(() => impliedPriceE18(1n, 0n, 6, 6)).toThrow(); });
});

describe('indexado · spread (bps com sinal)', () => {
  it('positivo, negativo e zero', () => {
    expect(applySpreadE18(E18, 0)).toBe(E18);
    expect(applySpreadE18(E18, 500)).toBe((E18 * 10_500n) / 10_000n);
    expect(applySpreadE18(E18, -500)).toBe((E18 * 9_500n) / 10_000n);
  });
  it('spread que aniquila o preço lança', () => { expect(() => applySpreadE18(E18, -10_000)).toThrow(); });
});

describe('indexado · quoteAmount (floor + resíduo)', () => {
  it('BTC(8)→USDT(6) a 64000 sem resíduo', () => {
    const r = computeQuoteAmount(100_000_000n, 64_000n * E18, 8, 6);
    expect(r.quoteAmount).toBe(64_000n * 1_000_000n);
    expect(r.residual).toBe(0n);
  });
  it('arredonda para BAIXO e registra o resíduo explícito', () => {
    // 1 unidade (0 casas) × 2.5 ⇒ 2, resíduo 0.5·1e18
    const r = computeQuoteAmount(1n, 2_500_000_000_000_000_000n, 0, 0);
    expect(r.quoteAmount).toBe(2n);
    expect(r.residual).toBe(500_000_000_000_000_000n);
  });
  it('decimais 6/8/9/18 produzem inteiros exatos', () => {
    expect(computeQuoteAmount(1_000_000n, E18, 6, 6).quoteAmount).toBe(1_000_000n);                 // 6→6
    expect(computeQuoteAmount(10n ** 18n, E18, 18, 18).quoteAmount).toBe(10n ** 18n);               // 18→18
    expect(computeQuoteAmount(1_000_000_000n, E18, 9, 6).quoteAmount).toBe(1_000_000n);             // 9→6 (1 unidade inteira)
    expect(computeQuoteAmount(100_000_000n, E18, 8, 18).quoteAmount).toBe(10n ** 18n);              // 8→18 (1 unidade inteira)
  });
  it('quoteAmount zero (valor base pequeno demais) lança', () => {
    expect(() => computeQuoteAmount(1n, 1n, 0, 0)).toThrow();
  });
  it('além de uint256 lança', () => {
    expect(() => computeQuoteAmount(UINT256_MAX + 1n, E18, 0, 0)).toThrow();
    expect(() => computeQuoteAmount(UINT256_MAX, 2n * E18, 0, 0)).toThrow(); // resultado > uint256
  });
});
