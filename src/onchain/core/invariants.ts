// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/core/src/invariants.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
import { TradeState } from "../types.js";

/** Snapshot mínimo de uma mesa para checagem de invariantes (usado por testes e pelo reconciliador do Router). */
export interface TradeSnapshot {
  tradeId: string;
  state: TradeState;
  sellerDeposited: boolean;
  buyerDeposited: boolean;
  feeCollected: boolean;
  feeChargedCount: number;
  settleCount: number;
  refundCount: number;
  expiresAt: number;
  settledAt?: number;
  expiredAt?: number;
}

export interface InvariantViolation { invariant: string; tradeId: string; detail: string }

/** Invariantes verificáveis automaticamente. Retorna lista (vazia = tudo OK). */
export function checkInvariants(s: TradeSnapshot): InvariantViolation[] {
  const v: InvariantViolation[] = [];
  const add = (invariant: string, detail: string) => v.push({ invariant, tradeId: s.tradeId, detail });

  if (s.settleCount > 1) add("NO_DOUBLE_SETTLE", `settleCount=${s.settleCount}`);
  if (s.refundCount > 1) add("NO_DOUBLE_REFUND", `refundCount=${s.refundCount}`);
  if (s.feeChargedCount > 1) add("FEE_ONCE", `feeChargedCount=${s.feeChargedCount}`);
  if (s.settleCount > 0 && s.refundCount > 0) add("SETTLE_XOR_REFUND", "mesa liquidada e reembolsada");
  if (s.state === TradeState.SETTLED && s.settledAt !== undefined && s.settledAt >= s.expiresAt) {
    add("NO_SETTLE_AFTER_EXPIRY", `settledAt=${s.settledAt} >= expiresAt=${s.expiresAt}`);
  }
  if ((s.state === TradeState.EXPIRED || s.state === TradeState.REFUNDED) && s.expiredAt !== undefined && s.expiredAt < s.expiresAt) {
    add("EXPIRE_ONLY_AFTER_DEADLINE", `expiredAt=${s.expiredAt} < expiresAt=${s.expiresAt}`);
  }
  if (s.state === TradeState.REFUNDED && (s.sellerDeposited || s.buyerDeposited)) {
    add("PRINCIPAL_RETURNED_ON_REFUND", "depósito ainda marcado após refund");
  }
  if (s.state === TradeState.SETTLED && (!s.sellerDeposited || !s.buyerDeposited)) {
    add("SETTLE_REQUIRES_BOTH_DEPOSITS", "liquidação sem ambos os depósitos");
  }
  if (s.state >= TradeState.SELLER_SIGNED && s.state !== TradeState.EXPIRED && s.state !== TradeState.REFUNDED && !s.feeCollected) {
    if (s.state !== TradeState.CREATED) add("FEE_AT_FIRST_SIGNATURE", "seller assinou sem fee cobrada");
  }
  return v;
}
