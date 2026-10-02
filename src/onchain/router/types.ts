// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/router/src/types.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
import type { ChainDescriptor, ChainId, Role, Signature, Terms, TradeEvent, TradeState, WalletAttestation } from "../types.js";

/** Transação não assinada que o Router devolve ao frontend/carteira (ou ao executor) para assinatura. */
export interface UnsignedTx {
  chainId: ChainId;
  /** Quem deve assinar (participante ou "ANY" para executores). */
  signer: string | "ANY";
  /** Representação específica da rede: EVM {to,data,value}; Solana {instructions base64}; Tron {contract,function,params}. */
  payload: Record<string, unknown>;
  description: string;
}

export interface OnChainTrade {
  tradeId: string;
  state: TradeState;
  termsHash: string;
  sellerDeposited: boolean;
  buyerDeposited: boolean;
  feeCollected: boolean;
  feeAmount: bigint;
  expiresAt: number;
  settledAt: number;
  expiredAt: number;
}

export interface Confirmation {
  txHash: string;
  status: "CONFIRMED" | "FAILED" | "TIMEOUT";
  confirmations: number;
  blockNumber?: number;
  reason?: string;
}

export interface PreflightIssue { code: string; message: string; role?: Role }

export interface PreflightReport {
  ok: boolean;
  issues: PreflightIssue[];
  chainNow: number;
  paused: boolean;
  onChainFeeBps: number;
}

export interface SubmitResult { txHash: string }

/**
 * CHAIN ADAPTER (Open/Closed): nova rede = novo adapter, sem tocar no CORE nem no Router.
 * Nenhum método move fundos por decisão do backend; o adapter só constrói/observa transações.
 */
export interface ChainAdapter {
  readonly chain: ChainDescriptor;
  computeIds(terms: Terms): { tradeId: string; termsHash: string };
  preflight(terms: Terms): Promise<PreflightReport>;
  buildCreateTrade(terms: Terms, attestations: [WalletAttestation, WalletAttestation, WalletAttestation, WalletAttestation]): Promise<UnsignedTx>;
  buildSign(terms: Terms, tradeId: string, approval: Signature): Promise<UnsignedTx>;
  buildSettle(tradeId: string): Promise<UnsignedTx>;
  buildExpire(tradeId: string): Promise<UnsignedTx>;
  buildRefund(tradeId: string): Promise<UnsignedTx>;
  /** Submissão por um executor sem custódia (relayer de Paymaster, sweeper de expiração, settle). */
  submitAsExecutor(tx: UnsignedTx): Promise<SubmitResult>;
  getTrade(tradeId: string): Promise<OnChainTrade | null>;
  waitForConfirmation(txHash: string, timeoutMs: number): Promise<Confirmation>;
  fetchEvents(tradeId: string): Promise<TradeEvent[]>;
  now(): Promise<number>;
}

export type TxStep = "CREATE" | "SELLER_SIGN" | "PAYMASTER_01_SIGN" | "PAYMASTER_02_SIGN" | "BUYER_SIGN" | "SETTLE" | "EXPIRE" | "REFUND";

export interface TxRecord { step: TxStep; txHash: string; status: Confirmation["status"] | "PENDING"; submittedAt: number; confirmedAt?: number; reason?: string }

export interface Divergence { detectedAt: number; expected: string; actual: string; detail: string }

/** Registro operacional (índice). NUNCA é autoridade para saldo/assinatura/settlement. */
export interface TradeRecord {
  tradeId: string;
  humanCode: string;
  correlationId: string;
  chainId: ChainId;
  terms: Terms;
  termsHash: string;
  /** Último estado lido da blockchain (fonte de verdade). */
  onChainState: TradeState;
  onChainCheckedAt: number;
  txs: TxRecord[];
  divergences: Divergence[];
  createdAt: number;
  updatedAt: number;
}

export interface TradeStateStore {
  get(tradeId: string): Promise<TradeRecord | null>;
  getByCorrelation(correlationId: string): Promise<TradeRecord | null>;
  put(record: TradeRecord): Promise<void>;
  listOpen(): Promise<TradeRecord[]>;
}

export interface RouterClock { now(): number }
