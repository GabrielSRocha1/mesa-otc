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

/**
 * Comissão dos PMs em unidades do ATIVO DO VENDEDOR — modo v3 com a perna do COMPRADOR externa
 * (pagamento em BTC/HTLC fora da rede): comissão = sellerAmount × (1−deságio) × comissão (piso).
 * O vendedor a deposita no signV2 junto de principal + fee; o settle a distribui aos PMs.
 * No modo normal (comprador on-chain) a comissão segue em buyerAsset — use commissionAmountOf lá.
 */
export function commissionInSellerAsset(sellerAmount: bigint, discountBps: number, commissionBps: number): bigint {
  for (const [k, v] of [["discountBps", discountBps], ["commissionBps", commissionBps]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new RangeError(`${k} inválido: ${v}`);
  }
  if (sellerAmount < 0n) throw new RangeError("sellerAmount negativo");
  return (sellerAmount * BigInt(10_000 - discountBps) * BigInt(commissionBps)) / (BPS_DENOMINATOR * BPS_DENOMINATOR);
}
