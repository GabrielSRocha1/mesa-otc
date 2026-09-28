/**
 * Máquina de estados do PRD §9 — mapa fechado de transições.
 * Qualquer par (de, para) fora do mapa é IllegalTransition (CA-50).
 */
import type { DealState } from './types.js';
import { DomainError } from './errors.js';

export const TRANSITIONS: Readonly<Record<DealState, readonly DealState[]>> = {
  DRAFT: ['CREATED', 'CANCELLED'],
  CREATED: ['WALLETS_CONNECTED', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  WALLETS_CONNECTED: ['ASSETS_VERIFIED', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  ASSETS_VERIFIED: ['LIQUIDITY_VERIFIED', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  LIQUIDITY_VERIFIED: ['AWAITING_SIGNATURES', 'ASSETS_VERIFIED', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  AWAITING_SIGNATURES: ['AWAITING_SIGNATURES', 'FULLY_SIGNED', 'ASSETS_VERIFIED', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  FULLY_SIGNED: ['SETTLEMENT_VALIDATION', 'EXPIRED', 'BLOCKED'],
  SETTLEMENT_VALIDATION: ['SETTLING', 'BLOCKED', 'EXPIRED'],
  SETTLING: ['SETTLED', 'BLOCKED'],
  SETTLED: [],
  EXPIRED: ['REFUNDING'],
  REFUNDING: ['REFUNDED'],
  REFUNDED: [],
  CANCELLED: [],
  BLOCKED: ['REFUNDING', 'CANCELLED']
};

export function canTransition(from: DealState, to: DealState): boolean { return TRANSITIONS[from].includes(to); }
export function assertTransition(from: DealState, to: DealState): void {
  if (!canTransition(from, to)) throw new DomainError('ILLEGAL_TRANSITION', `Transição ${from} → ${to} não permitida`, { from, to });
}
export const ACCEPTS_SIGNATURES: DealState = 'AWAITING_SIGNATURES';
export const SETTLEABLE_FROM: DealState = 'SETTLEMENT_VALIDATION';
export const CANCELLABLE_STATES: ReadonlySet<DealState> = new Set(['DRAFT', 'CREATED', 'WALLETS_CONNECTED', 'ASSETS_VERIFIED', 'LIQUIDITY_VERIFIED', 'AWAITING_SIGNATURES']);
