// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/types/src/index.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * @verum-otc/types — tipos compartilhados entre CORE, ROUTER, ADAPTERS, REGISTRY e INDEXER.
 * Nenhuma regra de negócio aqui: apenas contratos de dados.
 */

export type ChainKind = "SOLANA" | "EVM" | "TRON";

/** Identificador canônico de rede usado pelo Router. EVM = chainId numérico; Solana/Tron = IDs sintéticos estáveis. */
export type ChainId =
  | 1 | 56 | 137 | 42161 // mainnets EVM
  | 11155111 | 97 | 80002 | 421614 // testnets EVM
  | 728126428 | 3448148188 | 2494104990 // Tron mainnet / nile / shasta
  | 101 | 102 | 103; // Solana mainnet-beta / testnet / devnet (convenção interna)

export interface ChainDescriptor {
  chainId: ChainId;
  kind: ChainKind;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  isMainnet: boolean;
  /** Endereço do contrato/programa de escrow desta rede (um deployment por rede). */
  escrowAddress: string;
  rpcUrl: string;
  explorerUrl: string;
  requiredConfirmations: number;
}

/** Ordem obrigatória de assinatura: SELLER → PAYMASTER_01 → PAYMASTER_02 → BUYER. */
export enum Role {
  SELLER = 0,
  PAYMASTER_01 = 1,
  PAYMASTER_02 = 2,
  BUYER = 3,
}

export const SIGNING_ORDER: readonly Role[] = [Role.SELLER, Role.PAYMASTER_01, Role.PAYMASTER_02, Role.BUYER] as const;

/** Máquina de estados on-chain (espelha o contrato EVM/Tron e o programa Solana). */
export enum TradeState {
  NONE = 0,
  CREATED = 1,
  SELLER_SIGNED = 2,
  PAYMASTER_01_SIGNED = 3,
  PAYMASTER_02_SIGNED = 4,
  READY_TO_SETTLE = 5, // == BUYER_SIGNED
  SETTLED = 6,
  EXPIRED = 7,
  REFUNDED = 8,
}

export enum TokenStatus {
  ACTIVE = "ACTIVE",
  SUSPENDED = "SUSPENDED",
}

/** Programa de token na Solana. Nunca inferido pelo símbolo. */
export type SolanaTokenProgram = "TOKEN" | "TOKEN_2022";

export interface TokenEntry {
  chainId: ChainId;
  /** Endereço (EVM/Tron) ou mint (Solana). Identidade real do token. */
  address: string;
  tokenProgram?: SolanaTokenProgram;
  decimals: number;
  /** Apenas informativo. NUNCA usado para identificação. */
  symbol: string;
  status: TokenStatus;
  registryVersion: number;
  activatedAt: number;
  updatedAt: number;
  /** Para BTC tokenizado: qual representação está sendo usada (ex.: "WBTC", "cbBTC", "wBTC-Wormhole"). */
  representationOf?: string;
  /** Flag administrativa explícita: freeze authority tolerada (USDT/USDC possuem). */
  allowFreezeAuthority?: boolean;
  /** Verificação humana contra a fonte oficial do emissor antes de ativar em mainnet. */
  verifiedAgainstIssuer: boolean;
}

/** Termos da mesa — assinados pelos 4 participantes. Valores em unidades mínimas (bigint). */
export interface Terms {
  chainId: ChainId;
  escrowAddress: string;
  seller: string;
  buyer: string;
  paymaster01: string;
  paymaster02: string;
  sellerAsset: string;
  sellerAmount: bigint;
  buyerAsset: string;
  buyerAmount: bigint;
  platformFeeBps: number; // 3 = 0,03%
  commissionBps: number; // comissão comercial (informativa)
  discountBps: number; // deságio (informativo)
  slippageBps: number; // slippage (informativo)
  createdAt: number; // unix seconds
  expiresAt: number; // createdAt + 2400
  termsVersion: number; // 1
  nonce: bigint;
}

export interface FeeBreakdown {
  platformFeeBps: number;
  platformFee: bigint; // único valor transferido on-chain além dos principais
  commissionBps: number;
  commissionReference: bigint; // informativo
  discountBps: number;
  discountReference: bigint; // informativo
  slippageBps: number;
  feeAsset: string; // = sellerAsset (política v1)
}

export interface Signature {
  role: Role;
  signer: string;
  tradeId: string;
  termsHash: string;
  deadline: number;
  /** hex (EVM/Tron: 65 bytes r||s||v) ou base58/hex (Solana: assinatura ed25519 da transação). */
  signature: string;
}

export interface WalletAttestation {
  wallet: string;
  validUntil: number;
  signature: string;
}

export type TradeEventName =
  | "TradeCreated" | "ParticipantAuthorized" | "SellerSigned" | "BuyerSigned" | "Paymaster01Signed"
  | "Paymaster02Signed" | "DepositReceived" | "FeeCollected" | "SettlementReady" | "TradeSettled"
  | "TradeExpired" | "RefundExecuted" | "TokenAdded" | "TokenSuspended" | "TokenRemoved"
  | "EmergencyPaused" | "EmergencyUnpaused" | "ConfigurationChanged";

export interface TradeEvent {
  name: TradeEventName;
  chainId: ChainId;
  tradeId: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  data: Record<string, string | number | bigint | boolean>;
}

/** Resultado padronizado de validação. */
export type ValidationResult = { ok: true } | { ok: false; code: string; message: string };

export const ok = (): ValidationResult => ({ ok: true });
export const fail = (code: string, message: string): ValidationResult => ({ ok: false, code, message });
