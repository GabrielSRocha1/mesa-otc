/**
 * VERUM OTC — Domain Model
 * Tipos centrais, serialização canônica e cálculo do Deal Hash (arquitetura §11.2).
 * Quantias são sempre strings decimais de inteiros em unidades base (BigInt na lógica).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export type Network = 'bitcoin' | 'ethereum' | 'solana' | 'zcash' | 'tron';
export type KeyScheme = 'secp256k1' | 'ed25519';
export type Role = 'SELLER' | 'BUYER' | 'PAYMASTER_1' | 'PAYMASTER_2';
export type TokenStandard = 'native' | 'ERC-20' | 'SPL' | 'Token-2022' | 'TRC-20';
export type SettlementMode = 'ESCROW_NN' | 'HTLC';
export type RouteKind = 'ESCROW_NN' | 'HTLC' | 'MARKET';
export type Environment = 'dev' | 'testnet' | 'staging' | 'prod';

export const ROLES: readonly Role[] = ['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2'];
export const DEPOSITOR_ROLES: readonly Role[] = ['SELLER', 'BUYER'];
/**
 * Ordem OBRIGATÓRIA de assinatura da mesa: Vendedor → Pay Master 1 → Pay Master 2 → Comprador.
 * Independente do ROLE_CODE do envelope EIP-712 (aquele NÃO pode mudar — faz parte do hash).
 */
export const SIGNING_ORDER: readonly Role[] = ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'];

export type DealState =
  | 'DRAFT' | 'CREATED' | 'WALLETS_CONNECTED' | 'ASSETS_VERIFIED' | 'LIQUIDITY_VERIFIED'
  | 'AWAITING_SIGNATURES' | 'FULLY_SIGNED' | 'SETTLEMENT_VALIDATION' | 'SETTLING' | 'SETTLED'
  | 'EXPIRED' | 'REFUNDING' | 'REFUNDED' | 'CANCELLED' | 'BLOCKED';

export interface ChainRef { network: Network; chainId: string }
export const NETWORK_KEY_SCHEME: Record<Network, KeyScheme> = { bitcoin: 'secp256k1', ethereum: 'secp256k1', solana: 'ed25519', zcash: 'secp256k1', tron: 'secp256k1' };

/** Identificação canônica de ativo (RA-001). Nunca apenas símbolo. */
export interface CanonicalAsset {
  code: string;               // BTC, USDT… (apenas rótulo de exibição)
  network: Network;
  chainId: string;
  contractOrMint: string | null;
  assetId: string;            // CAIP-19
  decimals: number;
  tokenStandard: TokenStandard;
  issuer: string;             // 'native' | Tether | Circle…
  status: 'active' | 'suspended' | 'deprecated';
  expectedCodeHash?: string;  // EVM: hash do bytecode esperado
  expectedMintAuthority?: string | null; // Solana
}

export interface Participant { role: Role; network: Network; chainId: string; address: string; keyScheme: KeyScheme }

export interface ParticipantStatus extends Participant {
  connected: boolean;
  fundingRequired: boolean;
  funding: 'N/A' | 'PENDING' | 'SEEN' | 'FINAL';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
}

export interface Leg {
  index: number;
  asset: CanonicalAsset;
  amountBase: string;         // inteiro em unidades base
  from: Role;
  to: Role;
  escrowChain: Network;
  escrowContract: string;
  mode: SettlementMode;
}

export interface Pricing {
  referencePriceInUsd: string;  // decimal string
  referencePriceOutUsd: string;
  quoteTimestamp: number;
  priceValidUntil: number;
  usdValueIn: string;
  usdValueOut: string;
  discountBps: number;
  /** Comissão total (bps) paga pelo Comprador aos Pay Masters — variável separada do deságio; nunca somada ao fee de protocolo. */
  commissionBps: number;
  /** Distribuição da comissão entre Pay Masters (bps por papel, na ordem PAYMASTER_1, PAYMASTER_2); soma == commissionBps. */
  commissionSplitBps: number[];
  usdCommission: string;
  platformFeeBps: number;
  paymasterShareBps: number;
  maxSlippageBps: number;
  maxPriceDriftBps: number;     // banda tolerada entre assinatura e liquidação (ADR-009)
  networkCostEstimateUsd: { in: string; out: string };
  netAmountSellerBase: string;  // líquido do vendedor em assetOut
  priceSnapshotId: string;
}

export interface RouteLegPlan { escrowChain: Network; escrowContract: string; mode: SettlementMode; fundingOrder: number; timelockSec: number }
export interface Route { routeId: string; kind: RouteKind; legs: RouteLegPlan[]; estTimeSec: number; estCostUsd: string; htlcHash?: string; viable: boolean; note: string }

export interface Terms {
  schemaVersion: 1;
  environment: Environment;
  dealId: string;
  revision: number;
  createdAt: number;
  expiresAt: number;
  participants: Participant[];
  requiredSignatures: number;
  legs: Leg[];
  pricing: Pricing;
  route: { routeId: string; kind: RouteKind; legs: RouteLegPlan[]; htlcHash?: string };
  dealNonce: string;
}

export interface DealHashParts { dealHash: string; participantsRoot: string; legsRoot: string; legHashes: string[]; pricingHash: string; routeHash: string; domainHash: string }

export interface SignatureRecord {
  id: string; dealId: string; revision: number; role: Role; signer: string; scheme: KeyScheme;
  envelopeHash: string; signedHash: string; signature: string; nonce: string; receivedAt: number;
  status: 'valid' | 'invalid' | 'superseded' | 'replaced';
}

export interface LegExecution { index: number; step: 'PENDING' | 'VALIDATED' | 'SUBMITTED' | 'INCLUDED' | 'FINAL' | 'FAILED'; txRef: string | null; confirmations: number; error?: string }
export interface SettlementRecord {
  id: string; dealId: string; revision: number;
  status: 'VALIDATING' | 'EXECUTING' | 'CONFIRMING' | 'DONE' | 'FAILED' | 'REFUNDING' | 'REFUNDED';
  lockToken: string; startedAt: number; finishedAt: number | null; legs: LegExecution[]; failureReason?: string;
  idempotencyKey: string;
}

export interface RefundRecord { role: Role; legIndex: number; status: 'PENDING' | 'SUBMITTED' | 'REFUNDED'; txRef: string | null }

export interface DealEvent { seq: number; dealId: string; type: string; at: number; actor: string; payload: Record<string, unknown>; prevHash: string; hash: string }

export interface Deal {
  id: string;
  version: number;             // lock otimista
  state: DealState;
  revision: number;
  terms: Terms | null;         // null até LIQUIDITY_VERIFIED (termos congelados)
  hash: DealHashParts | null;
  draft: DealDraft;
  participants: ParticipantStatus[];
  requiredSignatures: number;
  validSignatures: number;
  signatures: SignatureRecord[];
  settlement: SettlementRecord | null;
  refunds: RefundRecord[];
  risk: { reason: string; rule: string; at: number } | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Papel cuja VEZ de assinar é agora (assinatura sequencial); null quando ninguém falta. */
  turnRole?: Role | null;
  /** Prazo (epoch ms) da vez atual — janela rolante por assinante (5 min). Reinicia a cada assinatura. */
  turnExpiresAt?: number | null;
  shareToken: string;
  onChain: Record<string, { registered: boolean; revision: number; meta?: Record<string, string | number> }>; // por cadeia de escrow (meta: tradeId/termsHash/janela on-chain dos adapters reais)
}

export interface DealDraft {
  assetIn: CanonicalAsset; assetOut: CanonicalAsset; amountInBase: string;
  discountBps: number; commissionBps: number; commissionSplitBps: number[]; maxSlippageBps: number; maxPriceDriftBps: number; expiresInSec: number;
  participants: Participant[];
}

export interface RiskEvent { id: string; dealId: string | null; wallet: string | null; rule: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; decision: 'ALLOW' | 'REVIEW' | 'BLOCK'; evidence: Record<string, unknown>; at: number }
export interface AuditEvent { seq: number; at: number; actorType: 'user' | 'operator' | 'system' | 'keeper'; actorId: string; category: string; dealId: string | null; payloadHash: string; payload: Record<string, unknown>; prevHash: string; hash: string }

/* ---------------- utilitários ---------------- */
export const sha256Hex = (data: string | Uint8Array): string => bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));

/** Serialização canônica: chaves ordenadas, sem espaços, bigint como string. */
export function canonicalize(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const o = v as Record<string, unknown>;
  // chaves undefined são omitidas (mesma semântica de JSON/JSONB) para que o hash sobreviva à persistência
  return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalize(o[k])).join(',') + '}';
}

export const ROLE_ORDER: Record<Role, number> = { SELLER: 0, BUYER: 1, PAYMASTER_1: 2, PAYMASTER_2: 3 };

export function legHashOf(l: Leg): string {
  return sha256Hex(canonicalize({ index: l.index, assetId: l.asset.assetId, network: l.asset.network, chainId: l.asset.chainId, contractOrMint: l.asset.contractOrMint, tokenStandard: l.asset.tokenStandard, decimals: l.asset.decimals, amountBase: l.amountBase, from: l.from, to: l.to, escrowChain: l.escrowChain, escrowContract: l.escrowContract, mode: l.mode }));
}

/** dealHash = SHA256(domainHash ‖ dealId ‖ revision ‖ participantsRoot ‖ legsRoot ‖ pricingHash ‖ routeHash ‖ expiresAt ‖ dealNonce) */
export function computeDealHash(t: Terms): DealHashParts {
  const domainHash = sha256Hex(`VERUM_OTC|${t.schemaVersion}|${t.environment}`);
  const parts = [...t.participants].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const participantsRoot = sha256Hex(parts.map(p => sha256Hex(canonicalize({ role: p.role, network: p.network, chainId: p.chainId, keyScheme: p.keyScheme, address: p.address }))).join(''));
  const legHashes = [...t.legs].sort((a, b) => a.index - b.index).map(legHashOf);
  const legsRoot = sha256Hex(legHashes.join(''));
  const pricingHash = sha256Hex(canonicalize(t.pricing));
  const routeHash = sha256Hex(canonicalize(t.route));
  const dealHash = sha256Hex([domainHash, t.dealId, String(t.revision), participantsRoot, legsRoot, pricingHash, routeHash, String(t.expiresAt), t.dealNonce].join('|'));
  return { dealHash, participantsRoot, legsRoot, legHashes, pricingHash, routeHash, domainHash };
}

export const TERMINAL_STATES: ReadonlySet<DealState> = new Set(['SETTLED', 'REFUNDED', 'CANCELLED']);
export const PRE_SETTLING_EXPIRABLE: ReadonlySet<DealState> = new Set(['CREATED', 'WALLETS_CONNECTED', 'ASSETS_VERIFIED', 'LIQUIDITY_VERIFIED', 'AWAITING_SIGNATURES', 'FULLY_SIGNED', 'SETTLEMENT_VALIDATION']);

export function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes); globalThis.crypto.getRandomValues(arr); return bytesToHex(arr);
}
export function newId(prefix: string): string { return `${prefix}-${Date.now().toString(36)}-${randomHex(6)}`; }
