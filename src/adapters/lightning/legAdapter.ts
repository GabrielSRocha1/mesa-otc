/**
 * LightningLegAdapter — a perna BTC da rota LIGHTNING_SWAP como SettlementAdapter (rede 'lightning'),
 * para o motor tratá-la uniformemente junto da perna USDT (escrow V2). Delega a entrega do BTC ao
 * nó LN (LightningService). NÃO é uma cadeia de escrow: o "settle" desta perna é PAGAR a invoice do
 * Comprador — o que revela a preimage R que o settleV2 do contrato usa.
 *
 * Invariantes:
 *  - A invoice (bolt11) e o htlcHash vêm do COMPRADOR, guardados na deal (deal.lightningInvoice).
 *  - registerDeal valida que a invoice casa com o htlcHash do deal (payment_hash == htlcHash).
 *  - A perna lightning não tem funding prévio (o SELLER/tesouraria tem fundingRequired=false) — o BTC
 *    é entregue no settle. O settlement engine só chama settle após validar o USDT FUNDED on-chain,
 *    então a invariante "só paga após o USDT travado" é garantida pela ordem do settle.
 *  - settle paga a invoice (obtém R), valida sha256(R)==htlcHash e expõe R em revealedPreimage.
 */
import { sha256Hex, type ChainRef, type Network, type CanonicalAsset } from '../../domain/types.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { DomainError } from '../../domain/errors.js';
import type { AdapterCapabilities, AssetVerification, DealCommitment, OnChainDealState, RegisterResult, SettlementAdapter, TxRef, TxStatus, ApprovalSignature } from '../types.js';
import type { LightningService } from './types.js';

export interface LnLegDeps { getDeal: (dealId: string) => Promise<{ lightningInvoice?: string; terms?: { route?: { htlcHash?: string } } | null } | null>; now?: () => number }

interface LnLegState { bolt11: string; htlcHash: string; status: OnChainDealState['status']; preimage?: string; settledTx?: string; refundedTx?: string }

export class LightningLegAdapter implements SettlementAdapter {
  readonly chain: ChainRef = { network: 'lightning' as Network, chainId: 'ln' };
  private readonly cache = new Map<string, LnLegState>();
  private readonly now: () => number;
  constructor(private readonly ln: LightningService, private readonly deps: LnLegDeps) { this.now = deps.now ?? (() => Date.now()); }

  capabilities(): AdapterCapabilities { return { escrowNN: false, htlc: true, verifiableSigSchemes: [], finalityConfirmations: 0, nativeCode: 'BTC' }; }
  escrowAddress(): string { return 'lightning'; }
  validateAddress(): boolean { return true; }  // a perna é identificada pela invoice, não por endereço
  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const ok = asset.network === 'lightning' && asset.contractOrMint === null;
    return { ok, reasons: ok ? [] : ['perna lightning exige BTC nativo (contractOrMint=null)'], observed: { exists: true, standard: 'native', decimals: 8 }, checkedAt: this.now() };
  }
  async getBalance(): Promise<bigint> { return (await this.ln.getBalance()).outboundSat; }
  async estimateCostUsd(): Promise<string> { return '0.01'; }

  private async hydrate(dealId: string): Promise<LnLegState> {
    const hit = this.cache.get(dealId); if (hit) return hit;
    const d = await this.deps.getDeal(dealId);
    const bolt11 = d?.lightningInvoice; const htlcHash = d?.terms?.route?.htlcHash;
    if (!bolt11 || !htlcHash) throw new DomainError('SETTLEMENT_FAILED', 'deal lightning sem invoice/htlcHash');
    const s: LnLegState = { bolt11, htlcHash: htlcHash.toLowerCase(), status: 'REGISTERED' };
    this.cache.set(dealId, s); return s;
  }

  async registerDeal(c: DealCommitment): Promise<RegisterResult> {
    const d = await this.deps.getDeal(c.dealId);
    const bolt11 = d?.lightningInvoice; if (!bolt11) throw new DomainError('SETTLEMENT_FAILED', 'operação lightning sem invoice do Comprador');
    if (!c.htlcHash) throw new DomainError('SETTLEMENT_FAILED', 'operação lightning sem htlcHash');
    // Valida que a invoice do Comprador casa com o hashlock do deal (payment_hash == htlcHash).
    const inv = await this.ln.decodeInvoice(bolt11);
    if (inv.paymentHash.toLowerCase() !== c.htlcHash.toLowerCase()) throw new DomainError('SETTLEMENT_FAILED', `invoice não corresponde ao htlcHash do deal (invoice ${inv.paymentHash} ≠ ${c.htlcHash})`);
    this.cache.set(c.dealId, { bolt11, htlcHash: c.htlcHash.toLowerCase(), status: 'REGISTERED' });
    return { chain: 'lightning', ref: `ln:${inv.paymentHash.slice(0, 16)}`, submittedAt: this.now(), meta: { bolt11, htlcHash: c.htlcHash, amountSat: inv.amountSat.toString() } };
  }
  /** A perna BTC lightning não é depositada antes — o BTC é entregue no settle (nó paga). */
  async deposit(): Promise<TxRef> { throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'perna lightning não é depositada — o BTC é entregue na liquidação'); }

  async settle(dealId: string, _legIndex: number, _sigs: ApprovalSignature[], _preimage?: string): Promise<TxRef> {
    const s = await this.hydrate(dealId);
    if (s.status === 'SETTLED' && s.preimage) return { chain: 'lightning', ref: s.settledTx as string, submittedAt: this.now() }; // idempotente
    // PAGA a invoice (entrega o BTC ao Comprador). O settlement já validou o USDT FUNDED on-chain.
    let pay = await this.ln.lookupPayment(s.htlcHash);
    if (pay.status !== 'succeeded') pay = await this.ln.payInvoice(s.bolt11, { timeoutSec: 60 });
    if (pay.status !== 'succeeded' || !pay.preimage) throw new DomainError('SETTLEMENT_FAILED', `pagamento Lightning falhou: ${pay.failureReason ?? 'sem preimage'}`);
    if (sha256Hex(hexToBytes(pay.preimage)) !== s.htlcHash) throw new DomainError('SETTLEMENT_FAILED', 'preimage revelada na Lightning não corresponde ao htlcHash');
    s.preimage = pay.preimage; s.status = 'SETTLED'; s.settledTx = `ln-paid:${pay.paymentHash.slice(0, 16)}`;
    return { chain: 'lightning', ref: s.settledTx, submittedAt: this.now() };
  }
  /** Nada a reembolsar na perna BTC: se a invoice não foi paga, o BTC nunca saiu do nó. */
  async refund(dealId: string): Promise<TxRef> { const s = await this.hydrate(dealId).catch(() => null); if (s) { s.status = 'REFUNDED'; s.refundedTx = 'ln-noop'; } return { chain: 'lightning', ref: 'ln-noop', submittedAt: this.now() }; }
  async supersede(): Promise<TxRef | null> { return null; }
  async getDealState(dealId: string): Promise<OnChainDealState> {
    const s = await this.hydrate(dealId).catch(() => null);
    if (!s) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
    // Pronta para liquidar (a entrega acontece no settle); FUNDED não bloqueia a validação do motor.
    const status = s.status === 'REGISTERED' ? 'FUNDED' : s.status;
    return { status, revision: 0, deposits: {}, settledLegs: s.settledTx ? { 0: s.settledTx } : {}, settledTx: s.settledTx, refundedTx: s.refundedTx };
  }
  async waitFinal(ref: string): Promise<TxStatus> { return { ref, status: 'final', confirmations: 1 }; }
  async revealedPreimage(dealId: string): Promise<string | null> { return (await this.hydrate(dealId).catch(() => null))?.preimage ?? null; }
}
