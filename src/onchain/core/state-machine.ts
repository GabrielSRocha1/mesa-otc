// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/core/src/state-machine.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
import { Role, TradeState } from "../types.js";

export type TradeEventKind =
  | "SELLER_SIGN" | "PAYMASTER_01_SIGN" | "PAYMASTER_02_SIGN" | "BUYER_SIGN" | "SETTLE" | "EXPIRE" | "REFUND";

/** Transições válidas. Qualquer outra combinação é rejeitada. */
const TRANSITIONS: Readonly<Record<TradeState, Partial<Record<TradeEventKind, TradeState>>>> = {
  [TradeState.NONE]: {},
  [TradeState.CREATED]: { SELLER_SIGN: TradeState.SELLER_SIGNED, EXPIRE: TradeState.EXPIRED },
  [TradeState.SELLER_SIGNED]: { PAYMASTER_01_SIGN: TradeState.PAYMASTER_01_SIGNED, EXPIRE: TradeState.EXPIRED },
  [TradeState.PAYMASTER_01_SIGNED]: { PAYMASTER_02_SIGN: TradeState.PAYMASTER_02_SIGNED, EXPIRE: TradeState.EXPIRED },
  [TradeState.PAYMASTER_02_SIGNED]: { BUYER_SIGN: TradeState.READY_TO_SETTLE, EXPIRE: TradeState.EXPIRED },
  [TradeState.READY_TO_SETTLE]: { SETTLE: TradeState.SETTLED, EXPIRE: TradeState.EXPIRED },
  [TradeState.SETTLED]: {},
  [TradeState.EXPIRED]: { REFUND: TradeState.REFUNDED },
  [TradeState.REFUNDED]: {},
};

export class InvalidTransitionError extends Error {
  constructor(public readonly from: TradeState, public readonly event: TradeEventKind) {
    super(`Transição inválida: ${TradeState[from]} --${event}--> (não permitida)`);
  }
}

export function canTransition(from: TradeState, event: TradeEventKind): boolean {
  return TRANSITIONS[from]?.[event] !== undefined;
}

export function transition(from: TradeState, event: TradeEventKind): TradeState {
  const to = TRANSITIONS[from]?.[event];
  if (to === undefined) throw new InvalidTransitionError(from, event);
  return to;
}

export function isTerminal(s: TradeState): boolean {
  return s === TradeState.SETTLED || s === TradeState.REFUNDED;
}

export function isExpirable(s: TradeState): boolean {
  return canTransition(s, "EXPIRE");
}

/** Qual papel deve assinar a seguir dado o estado atual (ou null). */
export function nextSigner(s: TradeState): Role | null {
  switch (s) {
    case TradeState.CREATED: return Role.SELLER;
    case TradeState.SELLER_SIGNED: return Role.PAYMASTER_01;
    case TradeState.PAYMASTER_01_SIGNED: return Role.PAYMASTER_02;
    case TradeState.PAYMASTER_02_SIGNED: return Role.BUYER;
    default: return null;
  }
}

export function signEventForRole(role: Role): TradeEventKind {
  return (["SELLER_SIGN", "PAYMASTER_01_SIGN", "PAYMASTER_02_SIGN", "BUYER_SIGN"] as const)[role];
}

/** Contador k/N de assinaturas coletadas. */
export function signatureCount(s: TradeState): number {
  switch (s) {
    case TradeState.SELLER_SIGNED: return 1;
    case TradeState.PAYMASTER_01_SIGNED: return 2;
    case TradeState.PAYMASTER_02_SIGNED: return 3;
    case TradeState.READY_TO_SETTLE:
    case TradeState.SETTLED: return 4;
    default: return 0;
  }
}
