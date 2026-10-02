// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/core/src/fee.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
import type { FeeBreakdown, Terms } from "../types.js";
import { BPS_DENOMINATOR, MAX_PLATFORM_FEE_BPS } from "./constants.js";

/** fee = amount × bps / 10_000 (floor). Ex.: 1_000_000 USDT × 3 / 10_000 = 300 USDT. */
export function computeFee(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_PLATFORM_FEE_BPS) {
    throw new RangeError(`bps inválido: ${bps}`);
  }
  if (amount < 0n) throw new RangeError("amount negativo");
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Decompõe os conceitos econômicos sem misturá-los. Apenas platformFee é movimentado on-chain. */
export function feeBreakdown(t: Terms): FeeBreakdown {
  return {
    platformFeeBps: t.platformFeeBps,
    platformFee: computeFee(t.sellerAmount, t.platformFeeBps),
    commissionBps: t.commissionBps,
    commissionReference: (t.sellerAmount * BigInt(t.commissionBps)) / BPS_DENOMINATOR,
    discountBps: t.discountBps,
    discountReference: (t.sellerAmount * BigInt(t.discountBps)) / BPS_DENOMINATOR,
    slippageBps: t.slippageBps,
    feeAsset: t.sellerAsset,
  };
}

/** Total que o SELLER precisa ter disponível na primeira assinatura (principal + fee). */
export function sellerRequiredBalance(t: Terms): bigint {
  return t.sellerAmount + computeFee(t.sellerAmount, t.platformFeeBps);
}
