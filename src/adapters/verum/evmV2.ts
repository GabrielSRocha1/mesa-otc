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
import { createPublicClient, createWalletClient, encodeFunctionData, hashTypedData, http, defineChain, isAddress, keccak256, zeroAddress, type Abi, type Chain, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { CanonicalAsset, ChainRef, Role } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { Role as OnchainRole, type WalletAttestation } from '../../onchain/types.js';
import { NATIVE_ASSET_EVM } from '../../onchain/core/index.js';
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
/** Perna NATIVA (ETH puro, sentinela EIP-7528): deposita via msg.value no signV2; sem approve. */
const isNativeAsset = (a: string): boolean => a.toLowerCase() === NATIVE_ASSET_EVM.toLowerCase();
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
  /** Tipo de liquidação: 0 = TRANSFER (escrow bilateral); 1 = SWAP (câmbio via router autorizado). */
  dealType: number;
  /** SWAP: router autorizado congelado nos termos (TRANSFER: zero address). */
  swapRouter: Hex;
  /** SWAP: mínimo de buyerAsset recebido do câmbio (proteção de slippage). */
  minAmountOut: bigint;
}
interface RawTradeV2 {
  termsHash: Hex; state: number; nextIdx: number; sellerExternal: boolean; sellerDeposited: boolean; buyerDeposited: boolean;
  feeCollected: boolean; feeAmount: bigint; settledAt: bigint; expiredAt: bigint;
  seller: Hex; paymaster01: Hex; paymaster02: Hex; buyer: Hex;
  sellerAsset: Hex; sellerAmount: bigint; buyerAsset: Hex; buyerAmount: bigint;
  expiresAt: bigint; htlcHash: Hex; commissionPm1: bigint; commissionPm2: bigint; revealedPreimage: Hex;
}

/** Legs EVM do commitment: índice da leg do vendedor/comprador NESTA rede (null = perna externa). */
export interface EvmLegMap { sellerLegIndex: number | null; buyerLegIndex: number | null; external: boolean; externalSide: 'SELLER' | 'BUYER' | null }
export function evmLegMapOf(c: DealCommitment): EvmLegMap {
  const evm = c.legs.filter(l => l.escrowChain === 'ethereum');
  if (evm.length === 2) {
    const sellerLeg = evm.find(l => l.from === 'SELLER'); const buyerLeg = evm.find(l => l.from === 'BUYER');
    if (!sellerLeg || !buyerLeg) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 espera uma leg do Vendedor e uma do Comprador');
    return { sellerLegIndex: sellerLeg.index, buyerLegIndex: buyerLeg.index, external: false, externalSide: null };
  }
  if (evm.length === 1) {
    const other = c.legs.find(l => l.escrowChain !== 'ethereum');
    const evmLeg = evm[0] as NonNullable<typeof evm[0]>;
    // Perna externa = qualquer rede com hashlock (BTC nativo em P2WSH ou SOL/SPL em HTLC na
    // Solana), de QUALQUER lado: vendedor externo (comprador deposita aqui) OU comprador externo
    // (vendedor deposita aqui; o pagamento destrava lá pela preimage do settle).
    if (!other) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 com uma leg exige a perna externa da outra rede');
    if (!c.htlcHash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'perna externa exige htlcHash (rota HTLC)');
    if (other.from === 'BUYER' && evmLeg.from === 'SELLER') {
      return { sellerLegIndex: evmLeg.index, buyerLegIndex: null, external: true, externalSide: 'BUYER' };
    }
    if (other.from !== 'SELLER' || evmLeg.from !== 'BUYER') {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'perna externa deve ser do Vendedor OU do Comprador (a outra deposita o token nesta rede)');
    }
    return { sellerLegIndex: null, buyerLegIndex: evmLeg.index, external: true, externalSide: 'SELLER' };
  }
  throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'deal sem leg EVM para o escrow V2');
}

/**
 * Constrói os TermsV2 on-chain a partir do commitment congelado (papéis presentes, 2–4).
 * `sellerEvm`: endereço EVM do VENDEDOR quando o participante está na rede bitcoin (deal HTLC) —
 * é nele que o contrato paga o token do comprador no settle.
 */
export function buildVerumTermsV2(c: DealCommitment, chainNow: number, externalEvm?: string | null): TermsV2Call {
  const map = evmLegMapOf(c);
  const order: Role[] = ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'];
  const present = order.map(r => c.participants.find(p => p.role === r)).filter(Boolean) as DealCommitment['participants'];
  if (present.length < 2) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 exige ao menos Vendedor e Comprador');
  const walletOf = (p: DealCommitment['participants'][number]): Hex => {
    if (/^0x[0-9a-fA-F]{40}$/.test(p.address)) return p.address as Hex;
    if (map.external && p.role === map.externalSide && externalEvm && /^0x[0-9a-fA-F]{40}$/.test(externalEvm)) return externalEvm as Hex;
    throw new DomainError('SETTLEMENT_NOT_ALLOWED', `participante ${p.role} sem endereço EVM para o escrow V2 (carteira multichain sem conta Ethereum?)`);
  };
  const legOf = (i: number | null) => (i === null ? null : c.legs.find(l => l.index === i) ?? null);
  const sellerLeg = legOf(map.sellerLegIndex);
  const buyerLeg = legOf(map.buyerLegIndex);
  const externalLeg = map.external ? c.legs.find(l => l.escrowChain !== 'ethereum') : null;
  const clamp = (n: number) => Math.min(Math.max(0, n), 10000);
  // Comissão ON-CHAIN: total em unidades do buyerAsset (commissionAmountOf = amountOut·c/(1−d−c))
  // repartido pelo split assinado; resto da divisão inteira fica com o PM1. Tudo explícito nos
  // termos. Com perna do COMPRADOR externa não há buyerAsset on-chain → comissões zeradas (o
  // contrato valida) — a comissão desse modo vive na perna de lá/fora do contrato.
  const commissionBps = clamp(c.terms.pricing.commissionBps);
  const buyerBase = BigInt((buyerLeg ?? externalLeg)?.amountBase ?? '0');
  // Sem PM1 nos participantes não há comissão on-chain (o contrato reverte commissionPm>0 sem a
  // cadeira) — zera aqui, como faz a rota Solana (common.ts), em vez de travar na criação.
  const hasPm1 = present.some(p => p.role === 'PAYMASTER_1');
  const cTotal = (map.externalSide === 'BUYER' || !hasPm1) ? 0n : commissionAmountOf(buyerBase, clamp(c.terms.pricing.discountBps), commissionBps);
  const split = c.terms.pricing.commissionSplitBps ?? [];
  const pm2Bps = split[1] ?? 0;
  const commissionPm2 = commissionBps > 0 ? cTotal * BigInt(clamp(pm2Bps)) / BigInt(commissionBps) : 0n;
  const commissionPm1 = cTotal - commissionPm2;
  // Perna EVM com contractOrMint NULO = ativo NATIVO (ETH puro) → sentinela EIP-7528 nos termos;
  // address(0) fica reservado para a perna EXTERNA (leg em outra rede, HTLC).
  const assetOf = (leg: typeof sellerLeg): Hex => (leg ? ((leg.asset.contractOrMint ?? NATIVE_ASSET_EVM) as Hex) : (zeroAddress as Hex));
  return {
    participants: present.map(p => ({ wallet: walletOf(p), role: ROLE_TO_ONCHAIN[p.role] })),
    sellerAsset: assetOf(sellerLeg),
    sellerAmount: BigInt((sellerLeg ?? externalLeg)?.amountBase ?? '0'),
    buyerAsset: assetOf(buyerLeg),
    buyerAmount: buyerBase,
    platformFeeBps: c.feeBps, commissionBps: clamp(c.terms.pricing.commissionBps), discountBps: clamp(c.terms.pricing.discountBps), slippageBps: clamp(c.terms.pricing.maxSlippageBps),
    createdAt: BigInt(chainNow), expiresAt: BigInt(chainNow + 2400), termsVersion: 2,
    nonce: deriveNonce(c.dealId, c.revision, c.dealNonce),
    htlcHash: map.external ? ('0x' + c.htlcHash) as Hex : ZERO32,
    commissionPm1, commissionPm2,
    // A mesa atual é sempre escrow bilateral (TRANSFER); o câmbio (SWAP) entra quando o produto
    // ganhar a rota de liquidação via router — os campos já viajam no typehash assinado.
    dealType: 0, swapRouter: zeroAddress as Hex, minAmountOut: 0n,
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
  private async write(fn: string, args: unknown[], account: PrivateKeyAccount = this.keeper, value = 0n): Promise<string> {
    const wallet = account === this.keeper ? this.keeperWallet : createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account });
    const hash = await wallet.writeContract({ address: this.escrowV2, abi: ESCROW_V2_ABI, functionName: fn, args, account, chain: this.viemChain, value });
    const rc = await this.pub.waitForTransactionReceipt({ hash, confirmations: this.cfg.confirmations });
    if (rc.status !== 'success') throw new Error(`tx ${fn} revertida (${hash})`);
    return hash;
  }
  /** msg.value exigido no signV2 do papel: perna NATIVA do depositante (0 nas demais). */
  private signValueOf(role: OnchainRole, t: RawTradeV2): bigint {
    if (role === OnchainRole.SELLER && !t.sellerExternal && isNativeAsset(t.sellerAsset)) return t.sellerAmount + t.feeAmount;
    if (role === OnchainRole.BUYER && isNativeAsset(t.buyerAsset)) return t.buyerAmount + t.commissionPm1 + t.commissionPm2 + (t.sellerExternal ? t.feeAmount : 0n);
    return 0n;
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
  /** Ativa um token na allowlist on-chain do escrow V2 (addToken) — ex.: WETH p/ "ETH embrulhado".
   *  Requer que o keeper seja o owner do contrato; senão a tx reverte (reportado ao chamador). */
  async addToken(token: Hex, decimals: number, symbol: string): Promise<{ txHash: string }> {
    const hash = await this.write('addToken', [token, decimals, symbol]);
    await this.pub.waitForTransactionReceipt({ hash: hash as Hex });
    return { txHash: hash };
  }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = Date.now(); const reasons: string[] = [];
    try {
      if (asset.network !== 'ethereum' || asset.chainId !== this.chain.chainId) return { ok: false, reasons: ['rede/chainId não corresponde ao adaptador'], observed: { exists: false }, checkedAt };
      // ETH NATIVO (perna nativa do escrow V2, sentinela EIP-7528): não há contrato para auditar —
      // a "autorização" é o protocolo da rede. Só os decimais precisam bater (18).
      if (asset.contractOrMint === null || isNativeAsset(asset.contractOrMint)) {
        if (asset.decimals !== 18) return { ok: false, reasons: [`ETH nativo tem 18 decimais (registro: ${asset.decimals})`], observed: { exists: true, decimals: 18, symbol: 'ETH' }, checkedAt };
        return { ok: true, reasons: [], observed: { exists: true, decimals: 18, symbol: 'ETH', standard: 'NATIVE' }, checkedAt };
      }
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
      // Participante da perna EXTERNA (vendedor OU comprador em outra rede): resolve o endereço
      // EVM dele pela carteira multichain — é onde o contrato paga/recebe nesta rede.
      const mapX = evmLegMapOf(c);
      const extRole = mapX.externalSide === 'BUYER' ? 'BUYER' as const : 'SELLER' as const;
      const extPart = c.participants.find(pp => pp.role === extRole);
      const externalEvm = extPart && /^0x[0-9a-fA-F]{40}$/.test(extPart.address) ? extPart.address : await this.deps.evmAddressOf?.(c.dealId, extRole) ?? null;
      const terms = buildVerumTermsV2(c, now, externalEvm);
      const map = evmLegMapOf(c);
      // Hash pelo PRÓPRIO contrato (função pure) — zero chance de divergência de EIP-712 off-chain.
      const termsHash = await this.view<Hex>('hashTermsV2', [terms]);
      const tradeId = computeTradeIdEvm(this.cfg.chainId, this.escrowV2, termsHash);
      const atts: WalletAttestation[] = [];
      for (const p of terms.participants) {
        atts.push(await signWalletAttestationEvm(this.cfg.attestorKey, this.cfg.chainId, this.escrowV2, p.wallet, Number(terms.expiresAt) + 3600));
      }
      const attTuples = atts.map(a => ({ validUntil: BigInt(a.validUntil), signature: a.signature as Hex }));
      // Criador: PM1 quando presente; bilateral → vendedor. O contrato exige msg.sender = criador.
      const pm1 = terms.participants.find(p => p.role === OnchainRole.PAYMASTER_01);
      const creatorAddr = (pm1 ?? terms.participants[0] as { wallet: Hex }).wallet;
      const creatorAcc = this.keyring?.accountByAddress(creatorAddr) ?? null;
      const baseMeta = { tradeId, termsHash, onChainCreatedAt: Number(terms.createdAt), onChainExpiresAt: Number(terms.expiresAt), buyerLegIndex: map.buyerLegIndex, sellerLegIndex: map.sellerLegIndex ?? -1 };
      if (!creatorAcc) {
        // CARTEIRA REAL: sem chave no backend — o registro vira um txRequest que a carteira do
        // criador (PM1) envia. tradeId/termsHash são determinísticos, então o restante do fluxo
        // (steps, settle) encontra a trade assim que o createTradeV2 confirmar on-chain.
        const data = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'createTradeV2', args: [terms, attTuples] });
        const meta = { ...baseMeta, registerPending: 1, registerFrom: creatorAddr, registerTx: JSON.stringify({ to: this.escrowV2, data, value: '0', chainId: this.cfg.chainId, from: creatorAddr }) } as VerumMeta;
        return { ...this.ref(`pending:createTradeV2:${tradeId}`), meta };
      }
      await this.ensureGas(creatorAcc.address);
      const tx = await this.write('createTradeV2', [terms, attTuples], creatorAcc);
      const meta = baseMeta as VerumMeta;
      return { ...this.ref(tx), meta };
    } catch (e) { this.fail('register', e); }
  }

  /** Depósito mesa = approve ERC20 da perna on-chain do papel (perna externa não passa por aqui). */
  async deposit(dealId: string, legIndex: number, _from: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    try {
      const t = await this.rawTrade(b.meta.tradeId);
      // Trade ainda NÃO registrada (createTradeV2 pendente do PM1): a dívida sai zerada do struct
      // vazio e o allowance 0 >= 0 marcava FINAL indevidamente — nunca marque depósito sem registro.
      if (Number(t.state) === StateV2.NONE) throw new DomainError('FUNDING_REQUIRED', 'Operação ainda não registrada on-chain — o Pay Master 1 precisa enviar o createTradeV2 (botão "Registrar on-chain" na esteira)', { registerPending: true, tradeId: b.meta.tradeId });
      const isSellerLeg = Number(b.meta.sellerLegIndex) === legIndex && Number(b.meta.sellerLegIndex) >= 0;
      // JÁ DEPOSITADO on-chain: no V2 o pagamento é PULADO no signV2 do papel (transferFrom), o que
      // ZERA o allowance. Se o papel já avançou (nextIdx passou) ou a trade saiu do SIGNING, o
      // depósito ESTÁ feito — exigir allowance de novo aqui era FUNDING_REQUIRED falso pós-assinatura.
      const onRole = isSellerLeg ? OnchainRole.SELLER : OnchainRole.BUYER;
      if (Number(t.state) !== StateV2.SIGNING || CANON.indexOf(onRole) < Number(t.nextIdx)) return this.ref('deposited');
      const owner = isSellerLeg ? t.seller : t.buyer;
      const token = isSellerLeg ? t.sellerAsset : t.buyerAsset;
      // Comprador deposita líquido + comissões on-chain dos PMs (pagas no settle).
      const base = isSellerLeg ? t.sellerAmount : t.buyerAmount + t.commissionPm1 + t.commissionPm2;
      // Fee acompanha a perna que a paga: vendedor on-chain OU comprador quando a perna do vendedor é externa.
      const paysFee = isSellerLeg ? !t.sellerExternal : t.sellerExternal;
      const due = base + (paysFee ? t.feeAmount : 0n);
      if (isNativeAsset(token)) {
        // Perna NATIVA: não existe approve — o ETH entra como msg.value na PRÓPRIA assinatura
        // (signV2 payable). O "depósito" aqui é só o gate de saldo da carteira.
        const balance = await this.pub.getBalance({ address: owner });
        if (balance >= due) return this.ref('native-onsign');
        throw new DomainError('FUNDING_REQUIRED', `Saldo de ETH insuficiente para o pagamento na assinatura: tem ${balance} wei, precisa ${due} wei (+ gás)`, { owner, balance: balance.toString(), due: due.toString(), native: true });
      }
      const allowance = await this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, this.escrowV2] }) as bigint;
      if (allowance >= due) return this.ref('approved');
      // CARTEIRA REAL (sem chave dev): allowance insuficiente é FUNDING_REQUIRED nominal — com os
      // números — e não um erro genérico de chave (que o re-check da assinatura engolia, deixando
      // o participante só com o gate seco "Deposite no escrow antes de assinar").
      if (!this.keyring?.accountByAddress(owner)) throw new DomainError('FUNDING_REQUIRED', `Autorize o token pela carteira (approve): liberado ${allowance} de ${due} necessários`, { token, owner, allowance: allowance.toString(), due: due.toString(), spender: this.escrowV2 });
      const acc = this.devAccount(owner);
      await this.ensureGas(acc.address);
      const wallet = createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account: acc });
      const h = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [this.escrowV2, due], account: acc, chain: this.viemChain });
      await this.pub.waitForTransactionReceipt({ hash: h });
      return this.ref(h);
    } catch (e) { if (e instanceof DomainError && e.code === 'FUNDING_REQUIRED') throw e; this.fail('deposit', e); }
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
      // Perna NATIVA do papel: o depósito É o msg.value do signV2 (principal + fee/comissões).
      const value = this.signValueOf(role, t);
      const tx = await this.write('signV2', [b.meta.tradeId as Hex, BigInt(deadline), approval.signature as Hex], sender, value);
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
    if (state === StateV2.NONE && b.meta.registerPending) {
      // Trade ainda não registrada on-chain: o criador (PM1) envia o createTradeV2 pela carteira;
      // os demais aguardam. O tradeId é determinístico — ao confirmar, os steps seguem normais.
      const isCreator = String(b.meta.registerFrom ?? '').toLowerCase() === signer.toLowerCase();
      if (isCreator) return { kind: 'txRequest', action: 'createTradeV2', txRequest: JSON.parse(String(b.meta.registerTx)) as Record<string, unknown>, tradeId: b.meta.tradeId };
      return { kind: 'waitRegister', tradeId: b.meta.tradeId, registerFrom: b.meta.registerFrom ?? null };
    }
    if (state !== StateV2.SIGNING || CANON.indexOf(onRole) < Number(t.nextIdx)) return { kind: 'done', tradeId: b.meta.tradeId, state };
    const now = await this.chainNow();
    const deadline = Math.min(now + 300, Number(t.expiresAt));
    let approve: Record<string, string> | null = null;
    let wrap: Record<string, string> | null = null;
    // ETH "embrulhado": cadeira ETH vira WETH no registro, mas a carteira do participante só tem
    // ETH nativo — sem o deposit() do WETH o signV2 reverte ao puxar o token. O passo devolve o
    // wrap que falta e a carteira o executa ANTES do approve (deposit é payable sem argumentos).
    const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'.toLowerCase(); // Sepolia (= app.WETH_SEPOLIA)
    const wrapIfNeeded = async (token: Hex, owner: Hex, due: bigint): Promise<void> => {
      if (String(token).toLowerCase() !== WETH) return;
      const bal = await this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) as bigint;
      if (bal < due) wrap = { to: token, valueWei: (due - bal).toString(), data: '0xd0e30db0' /* deposit() */ };
    };
    // Perna NATIVA (ETH puro): nada de wrap nem approve — o pagamento é o msg.value do signV2.
    const valueWei = this.signValueOf(onRole, t);
    if (onRole === OnchainRole.SELLER && !t.sellerExternal && valueWei === 0n) {
      const due = t.sellerAmount + t.feeAmount;
      const allowance = await this.pub.readContract({ address: t.sellerAsset, abi: ERC20_ABI, functionName: 'allowance', args: [signer as Hex, this.escrowV2] }) as bigint;
      if (allowance < due) approve = { token: t.sellerAsset, spender: this.escrowV2, amount: due.toString() };
      await wrapIfNeeded(t.sellerAsset, signer as Hex, due);
    } else if (onRole === OnchainRole.BUYER && valueWei === 0n) {
      const due = t.buyerAmount + t.commissionPm1 + t.commissionPm2 + (t.sellerExternal ? t.feeAmount : 0n);
      const allowance = await this.pub.readContract({ address: t.buyerAsset, abi: ERC20_ABI, functionName: 'allowance', args: [signer as Hex, this.escrowV2] }) as bigint;
      if (allowance < due) approve = { token: t.buyerAsset, spender: this.escrowV2, amount: due.toString() };
      await wrapIfNeeded(t.buyerAsset, signer as Hex, due);
    }
    const typedData = { domain: { ...evmDomain(this.cfg.chainId, this.escrowV2), chainId: this.cfg.chainId }, types: APPROVAL_TYPES, primaryType: 'Approval' as const, message: { tradeId: b.meta.tradeId as Hex, termsHash: b.meta.termsHash as Hex, role: onRole, deadline: BigInt(deadline) } };
    return {
      kind: 'evm', chainId: this.cfg.chainId, escrow: this.escrowV2, fn: 'signV2', deadline, approve, wrap,
      // Perna nativa: a carteira envia o signV2 com ESTE value (string wei; '0' nas demais pernas).
      valueWei: valueWei.toString(),
      typedData: { ...typedData, message: { ...typedData.message, deadline: String(deadline) } },
      // Digest EIP-712 pronto: fallback personal_sign p/ carteiras sem typed data (o contrato
      // aceita ECDSA sobre toEthSignedMessageHash(digest)) e hash de referência p/ ERC-1271.
      digestHex: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
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
    // Perna NATIVA do papel: o signV2 vai com o value do depósito (recalculado do estado on-chain).
    const t = await this.rawTrade(b.meta.tradeId);
    return { kind: 'txRequest', txRequest: { to: this.escrowV2, data, value: this.signValueOf(onRole, t).toString(), chainId: this.cfg.chainId } };
  }
}
