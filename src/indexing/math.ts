/**
 * Operar Indexado — matemática do fixing. 100% bigint, exata e determinística. NENHUM number/float
 * para valores de ativo ou preço (RF-ouro §0). Respeita os decimais de cada ativo; preço em escala 1e18.
 *
 * Convenções:
 *  - priceE18 = quantidade de QUOTE (unidade inteira) por 1 unidade INTEIRA de BASE, escalado por 1e18,
 *    já ajustado pelos decimais dos dois ativos.
 *  - Arredondamento SEMPRE para BAIXO (floor da divisão inteira) com resíduo explícito — a mesma
 *    convenção do resíduo da grade X/Y (o leftover é registrado, nunca descartado em silêncio).
 */

export const E18 = 10n ** 18n;
export const BPS = 10_000n;
/** Teto de uint256 — nenhuma perna pode exceder (o contrato liquida em uint256). */
export const UINT256_MAX = 2n ** 256n - 1n;

function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > 60) throw new RangeError(`decimais inválidos: ${n}`);
  return 10n ** BigInt(n);
}

/** Mediana inteira de uma lista de bigint. Ímpar → elemento central; par → média (floor) dos dois centrais. */
export function medianBigint(values: bigint[]): bigint {
  if (values.length === 0) throw new RangeError('mediana de lista vazia');
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid] as bigint;
  return ((s[mid - 1] as bigint) + (s[mid] as bigint)) / 2n;
}

/** Dispersão = (max − min) / mediana, em bps. Mediana zero → dispersão "infinita" (grande) p/ falhar fechado. */
export function dispersionBps(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const max = values.reduce((a, b) => (b > a ? b : a));
  const min = values.reduce((a, b) => (b < a ? b : a));
  const med = medianBigint(values);
  if (med <= 0n) return UINT256_MAX; // sem mediana positiva não há preço confiável
  return ((max - min) * BPS) / med;
}

/**
 * Preço implícito (priceE18) de UMA cotação: grossOut (unidades mínimas de QUOTE, ANTES da fee do swap)
 * para baseAmount (unidades mínimas de BASE). priceE18 = grossOut · 10^baseDec · 1e18 / (baseAmount · 10^quoteDec).
 */
export function impliedPriceE18(grossOut: bigint, baseAmount: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  if (baseAmount <= 0n) throw new RangeError('baseAmount deve ser positivo');
  if (grossOut < 0n) throw new RangeError('grossOut negativo');
  const num = grossOut * pow10(baseDecimals) * E18;
  const den = baseAmount * pow10(quoteDecimals);
  return num / den;
}

/** Aplica o spread (bps com sinal) ao preço de referência. priceFinal = price · (10000 + spread) / 10000. */
export function applySpreadE18(priceE18: bigint, spreadBps: number): bigint {
  if (!Number.isInteger(spreadBps)) throw new RangeError(`spread inválido: ${spreadBps}`);
  const factor = BPS + BigInt(spreadBps);
  if (factor <= 0n) throw new RangeError('spread aniquila o preço (fator ≤ 0)');
  return (priceE18 * factor) / BPS;
}

export interface QuoteAmountResult {
  /** quantidade do COMPRADOR (unidades mínimas de QUOTE), arredondada para BAIXO. */
  quoteAmount: bigint;
  /** resíduo da divisão inteira (numerador % denominador) — leftover explícito perdido no floor. */
  residual: bigint;
}

/**
 * quoteAmount = baseAmount · priceFinalE18 / 1e18, ajustando os decimais dos dois ativos, com floor + resíduo.
 *   num = baseAmount · priceFinalE18 · 10^quoteDec ; den = 1e18 · 10^baseDec ; quoteAmount = ⌊num/den⌋.
 */
export function computeQuoteAmount(baseAmount: bigint, priceFinalE18: bigint, baseDecimals: number, quoteDecimals: number): QuoteAmountResult {
  if (baseAmount <= 0n) throw new RangeError('baseAmount deve ser positivo');
  if (priceFinalE18 <= 0n) throw new RangeError('preço final deve ser positivo');
  const num = baseAmount * priceFinalE18 * pow10(quoteDecimals);
  const den = E18 * pow10(baseDecimals);
  const quoteAmount = num / den;
  const residual = num % den;
  if (quoteAmount <= 0n) throw new RangeError('quoteAmount resultou em zero (valor base pequeno demais para o preço)');
  if (quoteAmount > UINT256_MAX || baseAmount > UINT256_MAX) throw new RangeError('quoteAmount excede uint256');
  return { quoteAmount, residual };
}
