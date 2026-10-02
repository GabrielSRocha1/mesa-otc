// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/core/src/validation.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
import { type ChainId, type Terms, type TokenEntry, TokenStatus, type ValidationResult, fail, ok } from "../types.js";
import { CREATION_WINDOW_SECONDS, MAX_PLATFORM_FEE_BPS, TERMS_VERSION, TRADE_DURATION_SECONDS } from "./constants.js";

export interface RegistryLookup {
  getToken(chainId: ChainId, address: string): TokenEntry | undefined;
}

/** Normalização de endereço por família de rede: EVM é case-insensitive; Solana/Tron são case-sensitive. */
export function normalizeAddress(chainId: ChainId, address: string): string {
  const a = address.trim();
  return isEvmChain(chainId) ? a.toLowerCase() : a;
}

export function isEvmChain(chainId: ChainId): boolean {
  return [1, 56, 137, 42161, 11155111, 97, 80002, 421614].includes(chainId);
}

export function isTronChain(chainId: ChainId): boolean {
  return [728126428, 3448148188, 2494104990].includes(chainId);
}

export function isSolanaChain(chainId: ChainId): boolean {
  return [101, 102, 103].includes(chainId);
}

/** 4 carteiras distintas, nenhuma vazia, nenhuma exercendo dois papéis. */
export function validateParticipants(t: Terms): ValidationResult {
  const wallets = [t.seller, t.paymaster01, t.paymaster02, t.buyer];
  if (wallets.some((w) => !w || w.trim().length === 0)) return fail("ZERO_ADDRESS", "participante vazio");
  const norm = wallets.map((w) => normalizeAddress(t.chainId, w));
  if (new Set(norm).size !== 4) return fail("DUPLICATE_WALLET", "uma carteira não pode exercer dois papéis");
  return ok();
}

/** Ativos distintos por endereço/mint real (nunca por símbolo), ambos ACTIVE no registry da rede. */
export function validateAssets(t: Terms, registry: RegistryLookup): ValidationResult {
  const s = normalizeAddress(t.chainId, t.sellerAsset);
  const b = normalizeAddress(t.chainId, t.buyerAsset);
  if (s === b) return fail("SAME_ASSET", "seller e buyer devem negociar ativos diferentes (comparação por mint/contract)");
  const se = registry.getToken(t.chainId, t.sellerAsset);
  const be = registry.getToken(t.chainId, t.buyerAsset);
  if (!se || se.status !== TokenStatus.ACTIVE) return fail("TOKEN_NOT_AUTHORIZED", `sellerAsset não autorizado: ${t.sellerAsset}`);
  if (!be || be.status !== TokenStatus.ACTIVE) return fail("TOKEN_NOT_AUTHORIZED", `buyerAsset não autorizado: ${t.buyerAsset}`);
  if (t.sellerAmount <= 0n || t.buyerAmount <= 0n) return fail("INVALID_AMOUNT", "quantidades devem ser > 0");
  return ok();
}

export function validateEconomics(t: Terms, expectedFeeBps: number): ValidationResult {
  if (t.platformFeeBps !== expectedFeeBps) return fail("INVALID_FEE", `fee ${t.platformFeeBps} ≠ configurada ${expectedFeeBps}`);
  if (t.platformFeeBps > MAX_PLATFORM_FEE_BPS) return fail("FEE_TOO_HIGH", "fee acima do teto");
  if (t.termsVersion !== TERMS_VERSION) return fail("INVALID_TERMS_VERSION", "versão dos termos incompatível");
  for (const [k, v] of [["commissionBps", t.commissionBps], ["discountBps", t.discountBps], ["slippageBps", t.slippageBps]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 10_000) return fail("INVALID_BPS", `${k} fora de [0, 10000]`);
  }
  if (t.nonce < 0n) return fail("INVALID_NONCE", "nonce negativo");
  return ok();
}

export function validateTimestamps(t: Terms, nowSeconds: number): ValidationResult {
  if (!Number.isInteger(t.createdAt) || !Number.isInteger(t.expiresAt)) return fail("INVALID_TIMESTAMPS", "timestamps não inteiros");
  if (t.createdAt > nowSeconds + CREATION_WINDOW_SECONDS) return fail("INVALID_TIMESTAMPS", "createdAt no futuro");
  if (t.createdAt + CREATION_WINDOW_SECONDS < nowSeconds) return fail("INVALID_TIMESTAMPS", "createdAt muito antigo");
  if (t.expiresAt !== t.createdAt + TRADE_DURATION_SECONDS) {
    return fail("INVALID_TIMESTAMPS", `expiresAt deve ser createdAt + ${TRADE_DURATION_SECONDS}s (40 min)`);
  }
  return ok();
}

export function isExpired(nowSeconds: number, expiresAt: number): boolean {
  return nowSeconds >= expiresAt;
}

export function secondsRemaining(nowSeconds: number, expiresAt: number): number {
  return Math.max(0, expiresAt - nowSeconds);
}

/** Validação completa dos termos (CORE). O contrato repete tudo on-chain — isto é pré-validação, não autoridade. */
export function validateTerms(t: Terms, registry: RegistryLookup, nowSeconds: number, expectedFeeBps: number): ValidationResult {
  for (const r of [
    validateParticipants(t),
    validateAssets(t, registry),
    validateEconomics(t, expectedFeeBps),
    validateTimestamps(t, nowSeconds),
  ]) {
    if (!r.ok) return r;
  }
  return ok();
}
