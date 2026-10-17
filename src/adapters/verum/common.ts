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
import { commissionAmountOf } from '../../engines/signature.js';
import type { Role, Leg, Participant } from '../../domain/types.js';
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

/** Constrói os Terms on-chain a partir do commitment congelado da mesa.
 *  `absentPmPlaceholder`: sentinela de cadeira AUSENTE para contratos que aceitam 2–4
 *  participantes (Solana: Pubkey::default). Sem ele, os 4 papéis continuam obrigatórios
 *  (Tron/EVM v1 não têm cadeiras dinâmicas). */
export function buildVerumTerms(c: DealCommitment, chainId: ChainId, escrowAddress: string, chainNow: number, absentPmPlaceholder?: string, externalSentinel?: string): VerumTerms {
  const roles = new Map(c.participants.map(p => [p.role, p]));
  const seller = roles.get('SELLER'); const buyer = roles.get('BUYER'); const pm1 = roles.get('PAYMASTER_1'); const pm2 = roles.get('PAYMASTER_2');
  if (!seller || !buyer) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow Verum exige Vendedor e Comprador');
  if ((!pm1 || !pm2) && !absentPmPlaceholder) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow Verum exige exatamente 4 participantes (Vendedor, Comprador, PM1 e PM2) nesta rede');
  if (pm2 && !pm1) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Pay Master 2 exige a cadeira Pay Master 1');
  // Rota CROSS-CHAIN (BTC↔Solana): a perna no escrow Solana + uma perna externa (hashlock) em outra
  // rede. A externa vira a sentinela EXTERNAL_ASSET (não deposita/paga aqui); liquida pela preimage.
  // `externalSentinel` só é passado pelo adapter Solana ⇒ a perna on-chain é a de escrowChain 'solana'.
  if (externalSentinel && c.htlcHash) {
    const onChainLeg = c.legs.find(l => l.escrowChain === 'solana');
    const externalLeg = c.legs.find(l => l.escrowChain !== 'solana');
    if (onChainLeg && externalLeg) {
      return buildVerumTermsXchain(c, chainId, escrowAddress, chainNow, absentPmPlaceholder, externalSentinel, { seller, buyer, pm1, pm2, onChainLeg, externalLeg });
    }
  }
  const legIn = c.legs[0]; const legOut = c.legs[1];
  if (!legIn || !legOut) throw new DomainError('INVALID_INPUT', 'legs incompletas');
  if (legIn.escrowChain !== legOut.escrowChain) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow Verum liquida as duas legs na MESMA rede; rotas cross-chain usam o simulador/HTLC');
  // Solana (caminho com placeholder): perna NATIVA vira o sentinela Pubkey::default — SOL entra e
  // sai SOLTO (seller_sign_sol/buyer_sign_sol/settle_native_*). Tron/EVM v1 continuam só-token.
  const nativeOk = !!absentPmPlaceholder;
  if ((!legIn.asset.contractOrMint || !legOut.asset.contractOrMint) && !nativeOk) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow Verum é só-token (ERC20/TRC20/SPL) — sem moeda nativa');
  if (!legIn.asset.contractOrMint && !legOut.asset.contractOrMint) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'as duas pernas nativas não fazem sentido (SOL↔SOL)');
  const clamp = (n: number) => Math.min(Math.max(0, n), 10000);
  // Comissão ON-CHAIN (termos v2, Solana): total em unidades do buyerAsset repartido pelo split
  // assinado; resto da divisão inteira fica com o PM1 (mesma regra do escrow EVM V2). Cadeira de
  // PM ausente → comissão 0 naquele slot (o contrato valida).
  const commissionBps = clamp(c.terms.pricing.commissionBps);
  const cTotal = pm1 ? commissionAmountOf(BigInt(legOut.amountBase), clamp(c.terms.pricing.discountBps), commissionBps) : 0n;
  const split = c.terms.pricing.commissionSplitBps ?? [];
  const pm2Bps = split[1] ?? 0;
  const commissionPm2 = pm2 && commissionBps > 0 ? cTotal * BigInt(clamp(pm2Bps)) / BigInt(commissionBps) : 0n;
  const commissionPm1 = cTotal - commissionPm2;
  return {
    chainId, escrowAddress,
    seller: seller.address, buyer: buyer.address,
    paymaster01: pm1?.address ?? absentPmPlaceholder as string, paymaster02: pm2?.address ?? absentPmPlaceholder as string,
    sellerAsset: legIn.asset.contractOrMint ?? absentPmPlaceholder as string, sellerAmount: BigInt(legIn.amountBase),
    buyerAsset: legOut.asset.contractOrMint ?? absentPmPlaceholder as string, buyerAmount: BigInt(legOut.amountBase),
    platformFeeBps: c.feeBps, commissionBps, discountBps: clamp(c.terms.pricing.discountBps), slippageBps: clamp(c.terms.pricing.maxSlippageBps),
    // Termos v2 (comissões on-chain) valem para a rota Solana (a única que usa o placeholder de
    // cadeira ausente); Tron/EVM v1 permanecem na v1 — o serializer de cada chain decide os bytes.
    createdAt: chainNow, expiresAt: chainNow + TRADE_DURATION_SECONDS, termsVersion: absentPmPlaceholder ? 2 : 1, nonce: deriveNonce(c.dealId, c.revision, c.dealNonce),
    commissionPm1, commissionPm2,
  };
}

/** Termos CROSS-CHAIN (BTC↔Solana): a perna externa (BTC) vira EXTERNAL_ASSET e NÃO deposita/paga
 *  na Solana; a perna Solana é um token SPL. Espelha `buildVerumTermsV2` da EVM: exatamente um lado
 *  externo (vendedor OU comprador), htlcHash nos termos, comissões ZERO quando o comprador é externo
 *  (seriam em BTC). Os endereços são os SOLANA de cada papel (todos assinam on-chain na Solana). */
function buildVerumTermsXchain(
  c: DealCommitment, chainId: ChainId, escrowAddress: string, chainNow: number, absentPmPlaceholder: string | undefined, externalSentinel: string,
  parts: { seller: Participant; buyer: Participant; pm1?: Participant; pm2?: Participant; onChainLeg: Leg; externalLeg: Leg },
): VerumTerms {
  const { seller, buyer, pm1, pm2, onChainLeg, externalLeg } = parts;
  const legs = [onChainLeg, externalLeg];
  const sellerLeg = legs.find(l => l.from === 'SELLER'); const buyerLeg = legs.find(l => l.from === 'BUYER');
  if (!sellerLeg || !buyerLeg) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'cross-chain Solana exige uma perna do Vendedor e uma do Comprador');
  const sellerExternal = sellerLeg === externalLeg; const buyerExternal = buyerLeg === externalLeg;
  // A perna Solana (não externa) PRECISA ser token SPL (v1: sem SOL-nativo↔BTC).
  const onChainToken = onChainLeg.asset.contractOrMint;
  if (!onChainToken) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'v1 BTC↔Solana exige token SPL na perna Solana (SOL-nativo↔BTC é follow-up)');
  const clamp = (n: number) => Math.min(Math.max(0, n), 10000);
  const commissionBps = clamp(c.terms.pricing.commissionBps);
  // Comissão só é pagável on-chain quando o COMPRADOR deposita o token (vendedor externo); se o
  // comprador é externo (paga BTC), comissão = 0 (o contrato exige isso no create_trade).
  const cTotal = (buyerExternal || !pm1) ? 0n : commissionAmountOf(BigInt(buyerLeg.amountBase), clamp(c.terms.pricing.discountBps), commissionBps);
  const split = c.terms.pricing.commissionSplitBps ?? [];
  const pm2Bps = split[1] ?? 0;
  const commissionPm2 = pm2 && commissionBps > 0 ? cTotal * BigInt(clamp(pm2Bps)) / BigInt(commissionBps) : 0n;
  const commissionPm1 = cTotal - commissionPm2;
  const htlcHash = c.htlcHash?.startsWith('0x') ? c.htlcHash : `0x${c.htlcHash}`;
  return {
    chainId, escrowAddress,
    seller: seller.address, buyer: buyer.address,
    paymaster01: pm1?.address ?? absentPmPlaceholder as string, paymaster02: pm2?.address ?? absentPmPlaceholder as string,
    sellerAsset: sellerExternal ? externalSentinel : onChainToken, sellerAmount: BigInt(sellerLeg.amountBase),
    buyerAsset: buyerExternal ? externalSentinel : onChainToken, buyerAmount: BigInt(buyerLeg.amountBase),
    platformFeeBps: c.feeBps, commissionBps, discountBps: clamp(c.terms.pricing.discountBps), slippageBps: clamp(c.terms.pricing.maxSlippageBps),
    createdAt: chainNow, expiresAt: chainNow + TRADE_DURATION_SECONDS, termsVersion: 2, nonce: deriveNonce(c.dealId, c.revision, c.dealNonce),
    commissionPm1, commissionPm2, htlcHash,
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
