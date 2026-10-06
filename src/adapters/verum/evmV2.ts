/**
 * VerumEvmV2Adapter — porta SettlementAdapter sobre o escrow V2 (VerumOTCEscrowV2EVM, ADR-v4):
 * cadeiras dinâmicas 2–4 e perna HTLC. SUBSTITUI o adapter V1 quando VERUM_EVM_V2_ESCROW_ADDRESS
 * está definido.
 *
 * Mapeamento semântico (ponte mesa ↔ contrato):
 *  - registerDeal  → createTradeV2 (participants[] dos papéis PRESENTES; attestor assina 1 atestado
 *                    por participante). Deal HTLC_BTC: a perna Bitcoin vira "perna externa" —
 *                    sellerAsset = address(0), sellerAmount = sats, htlcHash = sha256(preimage).
 *  - deposit       → approve ERC20 (perna externa não deposita aqui: o lock é o HTLC Bitcoin)
 *  - recordApproval→ signV2 na vez do papel (ordem canônica on-chain pula cadeiras ausentes)
 *  - settle        → settleV2(tradeId, preimage) — com htlcHash != 0 o contrato EXIGE a preimage
 *                    e emite PreimageRevealed; o claim do BTC usa exatamente o mesmo segredo.
 *  - revealedPreimage → lê a preimage REVELADA NO CONTRATO (storage) — fecha o swap atômico.
 * Stateless: tudo re-derivável de deal.onChain.ethereum.meta (tradeId/termsHash) + RPC.
 *
 * Limite documentado: a perna externa do contrato é SEMPRE a do vendedor (quem entrega BTC).
 * BTC nativo do lado comprador exigiria o espelho no contrato — fora do escopo da v2.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, defineChain, isAddress, keccak256, zeroAddress, type Abi, type Chain, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { CanonicalAsset, ChainRef, Role } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { Role as OnchainRole, type WalletAttestation } from '../../onchain/types.js';
import { signApprovalEvm, signWalletAttestationEvm, computeTradeIdEvm, evmDomain, APPROVAL_TYPES } from '../../onchain/crypto/index.js';
import { commissionAmountOf } from '../../engines/signature.js';
import ESCROW_V2_ABI_JSON from '../../onchain/router/abi/verumOtcEscrowV2.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, OnChainDealStatus, ParticipantStepProvider, RegisterResult, SettlementAdapter, TxRef, TxStatus } from '../types.js';
import { deriveNonce, ROLE_TO_ONCHAIN, bindingOf, type VerumAdapterDeps, type VerumMeta } from './common.js';
import type { VerumEvmDevKeyring } from './keyring.js';
import type { VerumEvmSettings } from '../../config.js';

type Hex = `0x${string}`;
const ESCROW_V2_ABI = ESCROW_V2_ABI_JSON as Abi;
const MIN_GAS_WEI = 1n * 10n ** 15n;
const TOPUP_WEI = 4n * 10n ** 15n;
const ZERO32 = ('0x' + '0'.repeat(64)) as Hex;
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
] as const satisfies Abi;

/** StateV2 do contrato. */
export enum StateV2 { NONE = 0, SIGNING = 1, READY_TO_SETTLE = 2, SETTLED = 3, EXPIRED = 4, REFUNDED = 5 }
const CANON: OnchainRole[] = [OnchainRole.SELLER, OnchainRole.PAYMASTER_01, OnchainRole.PAYMASTER_02, OnchainRole.BUYER];

export interface TermsV2Call {
  participants: { wallet: Hex; role: number }[];
  sellerAsset: Hex; sellerAmount: bigint; buyerAsset: Hex; buyerAmount: bigint;
  platformFeeBps: number; commissionBps: number; discountBps: number; slippageBps: number;
  createdAt: bigint; expiresAt: bigint; termsVersion: number; nonce: bigint; htlcHash: Hex;
  /** Comissão ON-CHAIN dos PMs (unidades do buyerAsset) — split explícito calculado aqui e assinado por todos. */
  commissionPm1: bigint; commissionPm2: bigint;
}
interface RawTradeV2 {
  termsHash: Hex; state: number; nextIdx: number; sellerExternal: boolean; sellerDeposited: boolean; buyerDeposited: boolean;
  feeCollected: boolean; feeAmount: bigint; settledAt: bigint; expiredAt: bigint;
  seller: Hex; paymaster01: Hex; paymaster02: Hex; buyer: Hex;
  sellerAsset: Hex; sellerAmount: bigint; buyerAsset: Hex; buyerAmount: bigint;
  expiresAt: bigint; htlcHash: Hex; commissionPm1: bigint; commissionPm2: bigint; revealedPreimage: Hex;
}

/** Legs EVM do commitment: índice da leg do vendedor/comprador NESTA rede (null = perna externa). */
export interface EvmLegMap { sellerLegIndex: number | null; buyerLegIndex: number; external: boolean }
export function evmLegMapOf(c: DealCommitment): EvmLegMap {
  const evm = c.legs.filter(l => l.escrowChain === 'ethereum');
  if (evm.length === 2) {
    const sellerLeg = evm.find(l => l.from === 'SELLER'); const buyerLeg = evm.find(l => l.from === 'BUYER');
    if (!sellerLeg || !buyerLeg) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 espera uma leg do Vendedor e uma do Comprador');
    return { sellerLegIndex: sellerLeg.index, buyerLegIndex: buyerLeg.index, external: false };
  }
  if (evm.length === 1) {
    const other = c.legs.find(l => l.escrowChain !== 'ethereum');
    const buyerLeg = evm[0] as NonNullable<typeof evm[0]>;
    if (other?.escrowChain !== 'bitcoin' || other.from !== 'SELLER' || buyerLeg.from !== 'BUYER') {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 só suporta perna externa de BTC nativo do VENDEDOR (comprador deposita o token nesta rede)');
    }
    if (!c.htlcHash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'perna externa exige htlcHash (rota HTLC)');
    return { sellerLegIndex: null, buyerLegIndex: buyerLeg.index, external: true };
  }
  throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'deal sem leg EVM para o escrow V2');
}

/**
 * Constrói os TermsV2 on-chain a partir do commitment congelado (papéis presentes, 2–4).
 * `sellerEvm`: endereço EVM do VENDEDOR quando o participante está na rede bitcoin (deal HTLC) —
 * é nele que o contrato paga o token do comprador no settle.
 */
export function buildVerumTermsV2(c: DealCommitment, chainNow: number, sellerEvm?: string | null): TermsV2Call {
  const map = evmLegMapOf(c);
  const order: Role[] = ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'];
  const present = order.map(r => c.participants.find(p => p.role === r)).filter(Boolean) as DealCommitment['participants'];
  if (present.length < 2) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 exige ao menos Vendedor e Comprador');
  const walletOf = (p: DealCommitment['participants'][number]): Hex => {
    if (/^0x[0-9a-fA-F]{40}$/.test(p.address)) return p.address as Hex;
    if (p.role === 'SELLER' && map.external && sellerEvm && /^0x[0-9a-fA-F]{40}$/.test(sellerEvm)) return sellerEvm as Hex;
    throw new DomainError('SETTLEMENT_NOT_ALLOWED', `participante ${p.role} sem endereço EVM para o escrow V2 (carteira multichain sem conta Ethereum?)`);
  };
  const legOf = (i: number | null) => (i === null ? null : c.legs.find(l => l.index === i) ?? null);
  const sellerLeg = legOf(map.sellerLegIndex);
  const buyerLeg = legOf(map.buyerLegIndex) as NonNullable<ReturnType<typeof legOf>>;
  const btcLeg = map.external ? c.legs.find(l => l.escrowChain === 'bitcoin') : null;
  const clamp = (n: number) => Math.min(Math.max(0, n), 10000);
  // Comissão ON-CHAIN: total em unidades do buyerAsset (commissionAmountOf = amountOut·c/(1−d−c))
  // repartido pelo split assinado; resto da divisão inteira fica com o PM1. Tudo explícito nos termos.
  const commissionBps = clamp(c.terms.pricing.commissionBps);
  const cTotal = commissionAmountOf(BigInt(buyerLeg.amountBase), clamp(c.terms.pricing.discountBps), commissionBps);
  const split = c.terms.pricing.commissionSplitBps ?? [];
  const pm2Bps = split[1] ?? 0;
  const commissionPm2 = commissionBps > 0 ? cTotal * BigInt(clamp(pm2Bps)) / BigInt(commissionBps) : 0n;
  const commissionPm1 = cTotal - commissionPm2;
  return {
    participants: present.map(p => ({ wallet: walletOf(p), role: ROLE_TO_ONCHAIN[p.role] })),
    sellerAsset: (sellerLeg?.asset.contractOrMint ?? zeroAddress) as Hex,
    sellerAmount: BigInt((sellerLeg ?? btcLeg)?.amountBase ?? '0'),
    buyerAsset: buyerLeg.asset.contractOrMint as Hex,
    buyerAmount: BigInt(buyerLeg.amountBase),
    platformFeeBps: c.feeBps, commissionBps: clamp(c.terms.pricing.commissionBps), discountBps: clamp(c.terms.pricing.discountBps), slippageBps: clamp(c.terms.pricing.maxSlippageBps),
    createdAt: BigInt(chainNow), expiresAt: BigInt(chainNow + 2400), termsVersion: 2,
    nonce: deriveNonce(c.dealId, c.revision, c.dealNonce),
    htlcHash: map.external ? ('0x' + c.htlcHash) as Hex : ZERO32,
    commissionPm1, commissionPm2,
  };
}

const statusOfV2 = (state: StateV2, anyDeposit: boolean): OnChainDealStatus => {
  switch (state) {
    case StateV2.NONE: return 'NONE';
    case StateV2.SIGNING: return 'REGISTERED';
    case StateV2.READY_TO_SETTLE: return 'FUNDED';
    case StateV2.SETTLED: return 'SETTLED';
    case StateV2.EXPIRED: return anyDeposit ? 'FUNDED' : 'REGISTERED';
    case StateV2.REFUNDED: return 'REFUNDED';
    default: return 'SUPERSEDED';
  }
};

export class VerumEvmV2Adapter implements SettlementAdapter, ParticipantStepProvider {
  readonly chain: ChainRef;
  readonly escrowV2: Hex;
  private readonly viemChain: Chain;
  private readonly pub: PublicClient;
  private readonly keeper: PrivateKeyAccount;
  private readonly keeperWallet: WalletClient;
  constructor(private readonly cfg: VerumEvmSettings, private readonly keyring: VerumEvmDevKeyring | null, private readonly deps: VerumAdapterDeps & { evmAddressOf?: (dealId: string, role: Role) => Promise<string | null> }) {
    if (!cfg.escrowV2) throw new DomainError('INVALID_INPUT', 'VERUM_EVM_V2_ESCROW_ADDRESS ausente');
    this.escrowV2 = cfg.escrowV2;
    this.chain = { network: 'ethereum', chainId: String(cfg.chainId) };
    this.viemChain = defineChain({ id: cfg.chainId, name: `verum-evm-v2-${cfg.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
    this.pub = createPublicClient({ chain: this.viemChain, transport: http(cfg.rpcUrl) });
    this.keeper = privateKeyToAccount(cfg.keeperKey);
    this.keeperWallet = createWalletClient({ chain: this.viemChain, transport: http(cfg.rpcUrl), account: this.keeper });
  }

  private fail(op: string, e: unknown): never {
    const msg = e instanceof Error ? e.message : String(e);
    const short = /reverted with the following reason:\s*([^\n]+)/.exec(msg)?.[1] ?? /Error: (\w+)\(/.exec(msg)?.[1] ?? msg.split('\n')[0];
    if (/timeout|fetch|network|ECONN|503|429/i.test(msg)) throw new DomainError('ADAPTER_UNAVAILABLE', `RPC EVM indisponível (${op})`);
    if (/Expired/.test(msg)) throw new DomainError('DEAL_EXPIRED', `expirada on-chain (${op})`);
    throw new DomainError('SETTLEMENT_FAILED', `${op} on-chain falhou: ${short}`);
  }
  private view<T>(fn: string, args: unknown[] = []): Promise<T> { return this.pub.readContract({ address: this.escrowV2, abi: ESCROW_V2_ABI, functionName: fn, args }) as Promise<T>; }
  private async write(fn: string, args: unknown[], account: PrivateKeyAccount = this.keeper): Promise<string> {
    const wallet = account === this.keeper ? this.keeperWallet : createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account });
    const hash = await wallet.writeContract({ address: this.escrowV2, abi: ESCROW_V2_ABI, functionName: fn, args, account, chain: this.viemChain });
    const rc = await this.pub.waitForTransactionReceipt({ hash, confirmations: this.cfg.confirmations });
    if (rc.status !== 'success') throw new Error(`tx ${fn} revertida (${hash})`);
    return hash;
  }
  private async ensureGas(address: Hex): Promise<void> {
    if (!this.keyring) return;
    if (await this.pub.getBalance({ address }) >= MIN_GAS_WEI) return;
    const hash = await this.keeperWallet.sendTransaction({ to: address, value: TOPUP_WEI, account: this.keeper, chain: this.viemChain });
    await this.pub.waitForTransactionReceipt({ hash });
  }
  private devAccount(address: string): PrivateKeyAccount {
    const acc = this.keyring?.accountByAddress(address);
    if (!acc) throw new DomainError('SETTLEMENT_FAILED', `sem chave dev para ${address} — em produção o participante envia a própria transação`);
    return acc;
  }
  private async chainNow(): Promise<number> { return Number((await this.pub.getBlock({ blockTag: 'latest' })).timestamp); }
  private async rawTrade(tradeId: string): Promise<RawTradeV2> { return this.view<RawTradeV2>('getTradeV2', [tradeId as Hex]); }
  private ref(tx: string): TxRef { return { chain: 'ethereum', ref: tx, submittedAt: Date.now() }; }
  private async binding(dealId: string): Promise<{ meta: VerumMeta & { buyerLegIndex?: number; sellerLegIndex?: number | null } ; dealHash: string }> {
    const b = await bindingOf(this.deps, dealId, 'ethereum');
    if (!b) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `deal ${dealId} sem registro on-chain (meta ausente)`);
    return b;
  }

  capabilities(): AdapterCapabilities { return { escrowNN: true, htlc: false, verifiableSigSchemes: ['secp256k1'], finalityConfirmations: this.cfg.confirmations, nativeCode: 'ETH' }; }
  escrowAddress(): string { return this.escrowV2; }
  validateAddress(address: string): boolean { return /^0x[0-9a-fA-F]{40}$/.test(address) && isAddress(address); }
  async estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { return op === 'settle' ? '3.50' : '1.20'; }
  async mintToken(token: Hex, to: string, amount: bigint): Promise<void> {
    try { const h = await this.keeperWallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'mint', args: [to as Hex, amount], account: this.keeper, chain: this.viemChain }); await this.pub.waitForTransactionReceipt({ hash: h }); }
    catch (e) { this.fail('mint', e); }
  }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = Date.now(); const reasons: string[] = [];
    try {
      if (asset.network !== 'ethereum' || asset.chainId !== this.chain.chainId) return { ok: false, reasons: ['rede/chainId não corresponde ao adaptador'], observed: { exists: false }, checkedAt };
      if (asset.contractOrMint === null) return { ok: false, reasons: ['escrow Verum é só-token (sem moeda nativa)'], observed: { exists: false }, checkedAt };
      const addr = asset.contractOrMint as Hex;
      const code = await this.pub.getCode({ address: addr });
      if (!code || code === '0x') return { ok: false, reasons: ['contrato inexistente na rede'], observed: { exists: false }, checkedAt };
      const [decimals, symbol, active] = await Promise.all([
        this.pub.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
        this.pub.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
        this.view<boolean>('isTokenActive', [addr]),
      ]);
      if (Number(decimals) !== asset.decimals) reasons.push(`decimals divergente (on-chain ${decimals}, registro ${asset.decimals})`);
      if (!active) reasons.push('token não está ACTIVE no registry on-chain do escrow V2');
      return { ok: reasons.length === 0, reasons, observed: { exists: true, decimals: Number(decimals), symbol, standard: 'ERC-20', codeHash: keccak256(code) }, checkedAt };
    } catch (e) { this.fail('verifyAsset', e); }
  }
  async getBalance(address: string, asset: CanonicalAsset): Promise<bigint> {
    try {
      if (asset.contractOrMint === null) return await this.pub.getBalance({ address: address as Hex });
      return await this.pub.readContract({ address: asset.contractOrMint as Hex, abi: ERC20_ABI, functionName: 'balanceOf', args: [address as Hex] }) as bigint;
    } catch (e) { this.fail('getBalance', e); }
  }

  async registerDeal(c: DealCommitment): Promise<RegisterResult> {
    const existing = await bindingOf(this.deps, c.dealId, 'ethereum');
    if (existing) {
      const t = await this.rawTrade(existing.meta.tradeId).catch(() => null);
      if (t && Number(t.state) !== StateV2.NONE) return { ...this.ref('registered'), meta: existing.meta };
    }
    try {
      const now = await this.chainNow();
      // Vendedor em outra rede (BTC nativo): o endereço EVM de payout vem da carteira multichain.
      const sellerPart = c.participants.find(p => p.role === 'SELLER');
      const sellerEvm = sellerPart && /^0x[0-9a-fA-F]{40}$/.test(sellerPart.address) ? sellerPart.address : await this.deps.evmAddressOf?.(c.dealId, 'SELLER') ?? null;
      const terms = buildVerumTermsV2(c, now, sellerEvm);
      const map = evmLegMapOf(c);
      // Hash pelo PRÓPRIO contrato (função pure) — zero chance de divergência de EIP-712 off-chain.
      const termsHash = await this.view<Hex>('hashTermsV2', [terms]);
      const tradeId = computeTradeIdEvm(this.cfg.chainId, this.escrowV2, termsHash);
      const atts: WalletAttestation[] = [];
      for (const p of terms.participants) {
        atts.push(await signWalletAttestationEvm(this.cfg.attestorKey, this.cfg.chainId, this.escrowV2, p.wallet, Number(terms.expiresAt) + 3600));
      }
      const attTuples = atts.map(a => ({ validUntil: BigInt(a.validUntil), signature: a.signature as Hex }));
      // Criador: PM1 quando presente; bilateral → vendedor.
      const pm1 = terms.participants.find(p => p.role === OnchainRole.PAYMASTER_01);
      const creator = this.devAccount((pm1 ?? terms.participants[0] as { wallet: Hex }).wallet);
      await this.ensureGas(creator.address);
      const tx = await this.write('createTradeV2', [terms, attTuples], creator);
      const meta = { tradeId, termsHash, onChainCreatedAt: Number(terms.createdAt), onChainExpiresAt: Number(terms.expiresAt), buyerLegIndex: map.buyerLegIndex, sellerLegIndex: map.sellerLegIndex ?? -1 } as VerumMeta;
      return { ...this.ref(tx), meta };
    } catch (e) { this.fail('register', e); }
  }

  /** Depósito mesa = approve ERC20 da perna on-chain do papel (perna externa não passa por aqui). */
  async deposit(dealId: string, legIndex: number, _from: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    try {
      const t = await this.rawTrade(b.meta.tradeId);
      const isSellerLeg = Number(b.meta.sellerLegIndex) === legIndex && Number(b.meta.sellerLegIndex) >= 0;
      const owner = isSellerLeg ? t.seller : t.buyer;
      const token = isSellerLeg ? t.sellerAsset : t.buyerAsset;
      // Comprador deposita líquido + comissões on-chain dos PMs (pagas no settle).
      const base = isSellerLeg ? t.sellerAmount : t.buyerAmount + t.commissionPm1 + t.commissionPm2;
      // Fee acompanha a perna que a paga: vendedor on-chain OU comprador quando a perna do vendedor é externa.
      const paysFee = isSellerLeg ? !t.sellerExternal : t.sellerExternal;
      const due = base + (paysFee ? t.feeAmount : 0n);
      const allowance = await this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, this.escrowV2] }) as bigint;
      if (allowance >= due) return this.ref('approved');
      const acc = this.devAccount(owner);
      await this.ensureGas(acc.address);
      const wallet = createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account: acc });
      const h = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [this.escrowV2, due], account: acc, chain: this.viemChain });
      await this.pub.waitForTransactionReceipt({ hash: h });
      return this.ref(h);
    } catch (e) { this.fail('deposit', e); }
  }

  /** Submete signV2 na vez do papel (idempotente quando o papel já avançou o nextIdx on-chain). */
  async recordApproval(dealId: string, sig: ApprovalSignature): Promise<TxRef | null> {
    const b = await this.binding(dealId);
    const role = ROLE_TO_ONCHAIN[sig.role];
    try {
      const t = await this.rawTrade(b.meta.tradeId);
      const state = Number(t.state) as StateV2;
      if (state !== StateV2.SIGNING || CANON.indexOf(role) < Number(t.nextIdx)) return null; // já avançou
      const now = await this.chainNow();
      const deadline = Math.min(now + 300, Number(t.expiresAt));
      // Vendedor de BTC nativo: o signatário on-chain é a carteira EVM registrada nos TermsV2.
      const evmSigner = /^0x[0-9a-fA-F]{40}$/.test(sig.signer) ? sig.signer : role === OnchainRole.SELLER ? t.seller : sig.signer;
      const pk = this.keyring?.privateKeyByAddress(evmSigner);
      if (!pk) throw new DomainError('SETTLEMENT_FAILED', `sem chave dev para ${evmSigner} — fluxo de carteira real usa /v1/deals/:id/onchain-tx`);
      const approval = await signApprovalEvm(pk, this.cfg.chainId, this.escrowV2, b.meta.tradeId as Hex, b.meta.termsHash as Hex, role, deadline);
      // SELLER/BUYER precisam ser msg.sender (depositam na assinatura); PMs são relayáveis pelo keeper.
      const sender = role === OnchainRole.SELLER || role === OnchainRole.BUYER ? this.devAccount(evmSigner) : this.keeper;
      if (sender !== this.keeper) await this.ensureGas(sender.address);
      const tx = await this.write('signV2', [b.meta.tradeId as Hex, BigInt(deadline), approval.signature as Hex], sender);
      return this.ref(tx);
    } catch (e) { this.fail(`recordApproval:${sig.role}`, e); }
  }

  /** settleV2 único liquida a(s) perna(s) desta rede; com HTLC a preimage É obrigatória. */
  async settle(dealId: string, _legIndex: number, _signatures: ApprovalSignature[], preimage?: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    const t = await this.rawTrade(b.meta.tradeId);
    if (Number(t.state) === StateV2.SETTLED) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'trade já liquidada on-chain');
    if (t.htlcHash !== ZERO32 && !/^[0-9a-f]{64}$/.test(preimage ?? '')) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'settleV2 com HTLC exige a preimage (sha256) do swap');
    try { return this.ref(await this.write('settleV2', [b.meta.tradeId as Hex, t.htlcHash !== ZERO32 ? ('0x' + preimage) as Hex : '0x'])); }
    catch (e) { this.fail('settle', e); }
  }

  async refund(dealId: string, _legIndex: number): Promise<TxRef> {
    const b = await this.binding(dealId);
    const t = await this.rawTrade(b.meta.tradeId);
    const state = Number(t.state) as StateV2;
    if (state === StateV2.REFUNDED) return this.ref('refunded');
    const now = await this.chainNow();
    if (state !== StateV2.EXPIRED && now < Number(t.expiresAt)) {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'reembolso on-chain só após a expiração da janela de 40 min (retryRefunds completa)');
    }
    try { return this.ref(await this.write(state === StateV2.EXPIRED ? 'refundV2' : 'expireAndRefundV2', [b.meta.tradeId as Hex])); }
    catch (e) { this.fail('refund', e); }
  }

  async supersede(_dealId: string, _revision: number): Promise<TxRef | null> { return null; }

  async getDealState(dealId: string): Promise<OnChainDealState> {
    const bound = await bindingOf(this.deps, dealId, 'ethereum');
    if (!bound) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
    try {
      const t = await this.rawTrade(bound.meta.tradeId);
      const state = Number(t.state) as StateV2;
      const sellerLegIndex = Number(bound.meta.sellerLegIndex ?? 0);
      const buyerLegIndex = Number(bound.meta.buyerLegIndex ?? 1);
      const deposits: Record<number, string> = {};
      if (t.sellerDeposited && !t.sellerExternal && sellerLegIndex >= 0) deposits[sellerLegIndex] = t.sellerAmount.toString();
      if (t.buyerDeposited) deposits[buyerLegIndex] = t.buyerAmount.toString();
      const settledLegs: Record<number, string> = {};
      if (state === StateV2.SETTLED) { if (!t.sellerExternal && sellerLegIndex >= 0) settledLegs[sellerLegIndex] = 'onchain-settled'; settledLegs[buyerLegIndex] = 'onchain-settled'; }
      return {
        status: statusOfV2(state, t.sellerDeposited || t.buyerDeposited), revision: bound.revision, deposits, settledLegs,
        dealHash: bound.dealHash || undefined, expiresAt: Number(t.expiresAt), tradeId: bound.meta.tradeId,
      };
    } catch (e) { this.fail('getDealState', e); }
  }

  async waitFinal(ref: string): Promise<TxStatus> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) return { ref, status: 'final', confirmations: this.cfg.confirmations };
    try {
      const rc = await this.pub.getTransactionReceipt({ hash: ref as Hex });
      const latest = await this.pub.getBlockNumber();
      const confirmations = Number(latest - rc.blockNumber) + 1;
      if (rc.status === 'reverted') return { ref, status: 'reverted', confirmations, error: 'reverted' };
      return { ref, status: confirmations >= this.cfg.confirmations ? 'final' : 'included', confirmations };
    } catch { return { ref, status: 'pending', confirmations: 0 }; }
  }

  /** Preimage revelada NO CONTRATO (storage após settleV2) — é o gatilho do claim do BTC. */
  async revealedPreimage(dealId: string): Promise<string | null> {
    const bound = await bindingOf(this.deps, dealId, 'ethereum');
    if (!bound) return null;
    try {
      const pre = await this.view<Hex>('revealedPreimage', [bound.meta.tradeId as Hex]);
      return pre && pre !== '0x' ? pre.slice(2).toLowerCase() : null;
    } catch { return null; }
  }

  /* ---------- fluxo de carteira real (/v1/deals/:id/onchain-tx) ---------- */
  async buildParticipantStep(dealId: string, role: Role, signer: string): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    const onRole = ROLE_TO_ONCHAIN[role];
    const t = await this.rawTrade(b.meta.tradeId);
    const state = Number(t.state) as StateV2;
    if (state !== StateV2.SIGNING || CANON.indexOf(onRole) < Number(t.nextIdx)) return { kind: 'done', tradeId: b.meta.tradeId, state };
    const now = await this.chainNow();
    const deadline = Math.min(now + 300, Number(t.expiresAt));
    let approve: Record<string, string> | null = null;
    if (onRole === OnchainRole.SELLER && !t.sellerExternal) {
      const due = t.sellerAmount + t.feeAmount;
      const allowance = await this.pub.readContract({ address: t.sellerAsset, abi: ERC20_ABI, functionName: 'allowance', args: [signer as Hex, this.escrowV2] }) as bigint;
      if (allowance < due) approve = { token: t.sellerAsset, spender: this.escrowV2, amount: due.toString() };
    } else if (onRole === OnchainRole.BUYER) {
      const due = t.buyerAmount + t.commissionPm1 + t.commissionPm2 + (t.sellerExternal ? t.feeAmount : 0n);
      const allowance = await this.pub.readContract({ address: t.buyerAsset, abi: ERC20_ABI, functionName: 'allowance', args: [signer as Hex, this.escrowV2] }) as bigint;
      if (allowance < due) approve = { token: t.buyerAsset, spender: this.escrowV2, amount: due.toString() };
    }
    return {
      kind: 'evm', chainId: this.cfg.chainId, escrow: this.escrowV2, fn: 'signV2', deadline, approve,
      typedData: { domain: { ...evmDomain(this.cfg.chainId, this.escrowV2), chainId: this.cfg.chainId }, types: APPROVAL_TYPES, primaryType: 'Approval', message: { tradeId: b.meta.tradeId, termsHash: b.meta.termsHash, role: onRole, deadline: String(deadline) } },
      relayable: onRole === OnchainRole.PAYMASTER_01 || onRole === OnchainRole.PAYMASTER_02,
    };
  }
  async submitParticipantStep(dealId: string, role: Role, _signer: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    const onRole = ROLE_TO_ONCHAIN[role];
    const signature = String(body.signature ?? '');
    const deadline = Number(body.deadline ?? 0);
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !deadline) throw new DomainError('INVALID_INPUT', 'esperado { signature (65 bytes hex), deadline }');
    if (onRole === OnchainRole.PAYMASTER_01 || onRole === OnchainRole.PAYMASTER_02) {
      try { const tx = await this.write('signV2', [b.meta.tradeId as Hex, BigInt(deadline), signature as Hex]); return { kind: 'relayed', txHash: tx }; }
      catch (e) { this.fail(`participantStep:${role}`, e); }
    }
    const data = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'signV2', args: [b.meta.tradeId as Hex, BigInt(deadline), signature as Hex] });
    return { kind: 'txRequest', txRequest: { to: this.escrowV2, data, value: '0', chainId: this.cfg.chainId } };
  }
}
