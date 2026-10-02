/**
 * Porta SettlementAdapter (arquitetura §4.3/§10). O OTC Engine nunca vê RPC, ABI, scripts ou formatos de endereço.
 */
import type { CanonicalAsset, ChainRef, KeyScheme, Leg, Network, Participant, Role, Terms } from '../domain/types.js';

export interface AdapterCapabilities { escrowNN: boolean; htlc: boolean; verifiableSigSchemes: KeyScheme[]; finalityConfirmations: number; nativeCode: string }
export interface AssetVerification { ok: boolean; reasons: string[]; observed: { exists: boolean; decimals?: number; symbol?: string; codeHash?: string; mintAuthority?: string | null; standard?: string }; checkedAt: number }
export type OnChainDealStatus = 'NONE' | 'REGISTERED' | 'FUNDED' | 'SETTLED' | 'REFUNDED' | 'SUPERSEDED';
export interface OnChainDealState { status: OnChainDealStatus; revision: number; deposits: Record<number, string>; settledLegs: Record<number, string>; settledTx?: string; refundedTx?: string; dealHash?: string; expiresAt?: number; tradeId?: string }
export interface TxRef { chain: Network; ref: string; submittedAt: number }
/** Resultado de registerDeal: adapters reais devolvem meta (tradeId, termsHash, janela on-chain) persistida em deal.onChain[chain]. */
export interface RegisterResult extends TxRef { meta?: Record<string, string | number> }
export interface TxStatus { ref: string; status: 'pending' | 'included' | 'final' | 'reverted'; confirmations: number; error?: string }

export interface DealCommitment {
  dealId: string; revision: number; dealHash: string; expiresAt: number; participants: Participant[];
  legs: Leg[]; pricingHash: string; routeHash: string; domainHash: string; dealNonce: string; feeBps: number; treasury: string; htlcHash?: string;
  /** Termos congelados completos — adaptadores on-chain reais (EVM) precisam do pricing p/ montar o RegisterInput. O simulador local ignora. */
  terms: Terms;
}
export interface ApprovalSignature { role: Role; signer: string; scheme: KeyScheme; signature: string; nonce: string }
/** Verificador injetado: o simulador local reutiliza a mesma verificação criptográfica que o Signature Engine. */
export type ApprovalVerifier = (dealHash: string, participant: Participant, sig: ApprovalSignature) => Promise<boolean>;

export interface SettlementAdapter {
  readonly chain: ChainRef;
  capabilities(): AdapterCapabilities;
  escrowAddress(): string;
  validateAddress(address: string): boolean;
  verifyAsset(asset: CanonicalAsset): Promise<AssetVerification>;
  getBalance(address: string, asset: CanonicalAsset): Promise<bigint>;
  estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string>;
  registerDeal(commitment: DealCommitment): Promise<RegisterResult>;
  deposit(dealId: string, legIndex: number, from: string): Promise<TxRef>;
  /**
   * Opcional (adapters reais): submete o passo on-chain da vez (sellerSign/pmSign/buyerSign)
   * no momento em que a assinatura mesa é aceita. Falha deve lançar — a assinatura mesa é
   * abortada para que mesa e chain nunca divirjam.
   */
  recordApproval?(dealId: string, sig: ApprovalSignature): Promise<TxRef | null>;
  settle(dealId: string, legIndex: number, signatures: ApprovalSignature[], preimage?: string): Promise<TxRef>;
  refund(dealId: string, legIndex: number): Promise<TxRef>;
  supersede(dealId: string, revision: number): Promise<TxRef | null>;
  getDealState(dealId: string): Promise<OnChainDealState>;
  waitFinal(ref: string): Promise<TxStatus>;
  revealedPreimage(dealId: string): Promise<string | null>;
}

/**
 * Fluxo de CARTEIRA REAL (sem keyring dev): o participante assina/envia o próprio passo on-chain.
 * GET /v1/deals/:id/onchain-tx → buildParticipantStep (o que assinar/enviar agora);
 * POST → submitParticipantStep (relay de PMs / broadcast Solana / calldata p/ seller-buyer).
 */
export interface ParticipantStepProvider {
  buildParticipantStep(dealId: string, role: Role, signer: string): Promise<Record<string, unknown>>;
  submitParticipantStep(dealId: string, role: Role, signer: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export function hasParticipantSteps(a: SettlementAdapter): a is SettlementAdapter & ParticipantStepProvider {
  return typeof (a as Partial<ParticipantStepProvider>).buildParticipantStep === 'function';
}

export class AdapterRegistry {
  private map = new Map<Network, SettlementAdapter>();
  register(a: SettlementAdapter): this { this.map.set(a.chain.network, a); return this; }
  get(network: Network): SettlementAdapter | undefined { return this.map.get(network); }
  require(network: Network): SettlementAdapter { const a = this.map.get(network); if (!a) throw new Error(`Sem adaptador para ${network}`); return a; }
  all(): SettlementAdapter[] { return [...this.map.values()]; }
}
