/**
 * Ponte semântica mesa ↔ escrow canônico Verum (contratos verum-otc-onchain).
 * O escrow tem janela fixa de 40 min, 4 carteiras em ordem fixa, depósitos embutidos em
 * sellerSign/buyerSign e settle único para as duas legs. Estes helpers traduzem o
 * DealCommitment da mesa para os Terms on-chain e o TradeState para o status da porta.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { TradeState, Role as OnchainRole, type ChainId, type Terms as VerumTerms } from '../../onchain/types.js';
import { TRADE_DURATION_SECONDS } from '../../onchain/core/index.js';
import { DomainError } from '../../domain/errors.js';
import type { Role } from '../../domain/types.js';
import type { DealCommitment, OnChainDealStatus } from '../types.js';

export const ROLE_TO_ONCHAIN: Record<Role, OnchainRole> = {
  SELLER: OnchainRole.SELLER, PAYMASTER_1: OnchainRole.PAYMASTER_01, PAYMASTER_2: OnchainRole.PAYMASTER_02, BUYER: OnchainRole.BUYER,
};

/** Nonce u64 determinístico por (deal, revisão): replay de createTrade é bloqueado on-chain. */
export function deriveNonce(dealId: string, revision: number, dealNonce: string): bigint {
  const h = sha256(utf8ToBytes(`verum-nonce|${dealId}|${revision}|${dealNonce}`));
  return new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, false) & 0x7fffffffffffffffn;
}

export interface VerumMeta extends Record<string, string | number> { tradeId: string; termsHash: string; onChainCreatedAt: number; onChainExpiresAt: number }

/** Constrói os Terms on-chain a partir do commitment congelado da mesa. */
export function buildVerumTerms(c: DealCommitment, chainId: ChainId, escrowAddress: string, chainNow: number): VerumTerms {
  const roles = new Map(c.participants.map(p => [p.role, p]));
  const seller = roles.get('SELLER'); const buyer = roles.get('BUYER'); const pm1 = roles.get('PAYMASTER_1'); const pm2 = roles.get('PAYMASTER_2');
  if (!seller || !buyer || !pm1 || !pm2) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow Verum exige exatamente 4 participantes (Vendedor, Comprador, PM1 e PM2)');
  const legIn = c.legs[0]; const legOut = c.legs[1];
  if (!legIn || !legOut) throw new DomainError('INVALID_INPUT', 'legs incompletas');
  if (legIn.escrowChain !== legOut.escrowChain) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow Verum liquida as duas legs na MESMA rede; rotas cross-chain usam o simulador/HTLC');
  if (!legIn.asset.contractOrMint || !legOut.asset.contractOrMint) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow Verum é só-token (ERC20/TRC20/SPL) — sem moeda nativa');
  const clamp = (n: number) => Math.min(Math.max(0, n), 10000);
  return {
    chainId, escrowAddress,
    seller: seller.address, buyer: buyer.address, paymaster01: pm1.address, paymaster02: pm2.address,
    sellerAsset: legIn.asset.contractOrMint, sellerAmount: BigInt(legIn.amountBase),
    buyerAsset: legOut.asset.contractOrMint, buyerAmount: BigInt(legOut.amountBase),
    platformFeeBps: c.feeBps, commissionBps: clamp(c.terms.pricing.commissionBps), discountBps: clamp(c.terms.pricing.discountBps), slippageBps: clamp(c.terms.pricing.maxSlippageBps),
    createdAt: chainNow, expiresAt: chainNow + TRADE_DURATION_SECONDS, termsVersion: 1, nonce: deriveNonce(c.dealId, c.revision, c.dealNonce),
  };
}

/** TradeState on-chain → status da porta mesa (READY_TO_SETTLE = ambas depositadas = FUNDED). */
export function statusFromTradeState(state: TradeState, sellerDeposited: boolean, buyerDeposited: boolean): OnChainDealStatus {
  switch (state) {
    case TradeState.NONE: return 'NONE';
    case TradeState.CREATED: case TradeState.SELLER_SIGNED: case TradeState.PAYMASTER_01_SIGNED: case TradeState.PAYMASTER_02_SIGNED: return 'REGISTERED';
    case TradeState.READY_TO_SETTLE: return 'FUNDED';
    case TradeState.SETTLED: return 'SETTLED';
    case TradeState.EXPIRED: return sellerDeposited || buyerDeposited ? 'FUNDED' : 'REGISTERED';
    case TradeState.REFUNDED: return 'REFUNDED';
    default: return 'SUPERSEDED';
  }
}

/** Depósitos por leg a partir das flags on-chain (leg 0 = seller, leg 1 = buyer). */
export function depositsOf(sellerDeposited: boolean, buyerDeposited: boolean, sellerAmount: bigint, buyerAmount: bigint): Record<number, string> {
  const d: Record<number, string> = {};
  if (sellerDeposited) d[0] = sellerAmount.toString();
  if (buyerDeposited) d[1] = buyerAmount.toString();
  return d;
}

/** Estados em que o passo on-chain do papel JÁ aconteceu (idempotência de reprocesso serverless). */
export const ROLE_ALREADY_ADVANCED: Record<OnchainRole, TradeState[]> = {
  [OnchainRole.SELLER]: [TradeState.SELLER_SIGNED, TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
  [OnchainRole.PAYMASTER_01]: [TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
  [OnchainRole.PAYMASTER_02]: [TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
  [OnchainRole.BUYER]: [TradeState.READY_TO_SETTLE, TradeState.SETTLED],
};

export interface VerumAdapterDeps {
  /** Acesso ao Deal persistido (stateless/serverless: tudo re-derivável de terms + meta + RPC). */
  getDeal(dealId: string): Promise<{ hash: { dealHash: string } | null; onChain: Record<string, { revision?: number; meta?: Record<string, string | number> }> } | null>;
}

export async function bindingOf(deps: VerumAdapterDeps, dealId: string, network: string): Promise<{ meta: VerumMeta; dealHash: string; revision: number } | null> {
  const deal = await deps.getDeal(dealId);
  const entry = deal?.onChain[network];
  const meta = entry?.meta as VerumMeta | undefined;
  if (!deal || !meta?.tradeId) return null;
  return { meta, dealHash: deal.hash?.dealHash ?? '', revision: entry?.revision ?? 1 };
}
