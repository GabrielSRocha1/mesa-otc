/**
 * VerumTronV2Adapter — porta SettlementAdapter sobre o escrow V2 na TVM (VerumOTCEscrowV2Tron,
 * ADR-v4): cadeiras dinâmicas 2–4, perna HTLC (hashlock) e perna TRX NATIVA (sentinela EIP-7528,
 * callValue em SUN). SUBSTITUI o adapter V1 quando TRON_ESCROW_V2_ADDRESS está definido.
 *
 * Mesmo mapeamento semântico do VerumEvmV2Adapter (é o MESMO contrato Solidity, chain id injetado):
 *  - registerDeal  → createTradeV2 (deal HTLC_BTC: perna Bitcoin vira "perna externa" com htlcHash)
 *  - deposit       → approve TRC-20 (nativa: gate de saldo — o TRX entra como callValue no signV2)
 *  - recordApproval→ signV2 na vez do papel (EIP-712 com chainId Tron + escrow hex20, como no V1)
 *  - settle        → settleV2(tradeId, preimage) — com htlcHash != 0 o contrato EXIGE a preimage
 *  - revealedPreimage → lê a preimage revelada no contrato — fecha o swap atômico com o BTC.
 * Stateless: tudo re-derivável de deal.onChain.tron.meta (tradeId/termsHash) + RPC.
 */
import type { CanonicalAsset, ChainRef, Role } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { Role as OnchainRole, type WalletAttestation } from '../../onchain/types.js';
import { NATIVE_ASSET_EVM } from '../../onchain/core/index.js';
import { signApprovalEvm, signWalletAttestationEvm, computeTradeIdEvm, evmDomain, evmToTronAddress, APPROVAL_TYPES } from '../../onchain/crypto/index.js';
import { tronAddrToHex20 } from '../../onchain/router/adapters/tron.js';
import { commissionAmountOf } from '../../engines/signature.js';
import ESCROW_V2_ABI from '../../onchain/router/abi/verumOtcEscrowV2.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, OnChainDealStatus, ParticipantStepProvider, RegisterResult, SettlementAdapter, TxRef, TxStatus } from '../types.js';
import { deriveNonce, ROLE_TO_ONCHAIN, bindingOf, type VerumAdapterDeps, type VerumMeta } from './common.js';
import { StateV2, type TermsV2Call } from './evmV2.js';
import type { TronDevKeyring } from './keyring.js';
import type { TronSettings } from '../../config.js';

type Hex = `0x${string}`;
const FEE_LIMIT_SUN = 400_000_000;
const ZERO32 = ('0x' + '0'.repeat(64)) as Hex;
const ZERO20 = ('0x' + '0'.repeat(40)) as Hex;
const isNativeAsset = (a: string): boolean => a.toLowerCase() === NATIVE_ASSET_EVM.toLowerCase();
const CANON: OnchainRole[] = [OnchainRole.SELLER, OnchainRole.PAYMASTER_01, OnchainRole.PAYMASTER_02, OnchainRole.BUYER];
const SIGN_FNS = ['sellerSign', 'paymaster01Sign', 'paymaster02Sign', 'buyerSign'] as const;
void SIGN_FNS; // V2 usa signV2 único — mantido só como referência da ordem canônica

/** getTradeV2 normalizado (tronweb devolve Result do ethers: acesso por nome). */
interface RawTradeV2Tron {
  termsHash: Hex; state: number; nextIdx: number; sellerExternal: boolean; sellerDeposited: boolean; buyerDeposited: boolean;
  feeAmount: bigint; seller: Hex; paymaster01: Hex; paymaster02: Hex; buyer: Hex;
  sellerAsset: Hex; sellerAmount: bigint; buyerAsset: Hex; buyerAmount: bigint;
  expiresAt: bigint; htlcHash: Hex; commissionPm1: bigint; commissionPm2: bigint;
}

interface TronWebV2 {
  defaultAddress: { base58: string; hex: string };
  address: { fromPrivateKey(k: string): string; fromHex(h: string): string; toHex(b58: string): string };
  trx: { getBalance(a: string): Promise<number>; sign(tx: unknown, pk?: string): Promise<unknown>; sendRawTransaction(tx: unknown): Promise<{ result?: boolean; txid?: string; code?: string; message?: string }>; getTransactionInfo(id: string): Promise<{ id?: string; blockNumber?: number; receipt?: { result?: string }; contractResult?: string[] }>; getCurrentBlock(): Promise<{ block_header: { raw_data: { number: number; timestamp: number } } }> };
  contract(abi: unknown[], address: string): Promise<Record<string, (...args: unknown[]) => { call(): Promise<unknown>; send(o: { feeLimit: number; callValue?: number }): Promise<string> }>> | Record<string, (...args: unknown[]) => { call(): Promise<unknown>; send(o: { feeLimit: number; callValue?: number }): Promise<string> }>;
}

/** Legs Tron do commitment: espelho do evmLegMapOf para escrowChain 'tron'. */
export interface TronLegMap { sellerLegIndex: number | null; buyerLegIndex: number | null; external: boolean; externalSide: 'SELLER' | 'BUYER' | null }
export function tronLegMapOf(c: DealCommitment): TronLegMap {
  const tron = c.legs.filter(l => l.escrowChain === 'tron');
  if (tron.length === 2) {
    const sellerLeg = tron.find(l => l.from === 'SELLER'); const buyerLeg = tron.find(l => l.from === 'BUYER');
    if (!sellerLeg || !buyerLeg) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 Tron espera uma leg do Vendedor e uma do Comprador');
    return { sellerLegIndex: sellerLeg.index, buyerLegIndex: buyerLeg.index, external: false, externalSide: null };
  }
  if (tron.length === 1) {
    const other = c.legs.find(l => l.escrowChain !== 'tron');
    const tronLeg = tron[0] as NonNullable<typeof tron[0]>;
    if (!other) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 Tron com uma leg exige a perna externa da outra rede');
    if (!c.htlcHash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'perna externa exige htlcHash (rota HTLC)');
    if (other.from === 'BUYER' && tronLeg.from === 'SELLER') return { sellerLegIndex: tronLeg.index, buyerLegIndex: null, external: true, externalSide: 'BUYER' };
    if (other.from !== 'SELLER' || tronLeg.from !== 'BUYER') throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'perna externa deve ser do Vendedor OU do Comprador (a outra deposita o token nesta rede)');
    return { sellerLegIndex: null, buyerLegIndex: tronLeg.index, external: true, externalSide: 'SELLER' };
  }
  throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'deal sem leg Tron para o escrow V2');
}

const isTronB58 = (a: string): boolean => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);

/** TermsV2 on-chain (hex20) a partir do commitment. `externalTron`: endereço Tron do papel da
 *  perna externa (ex.: vendedor de BTC) — é onde o contrato paga o TRC-20/TRX no settle. */
export function buildVerumTermsV2Tron(c: DealCommitment, chainNow: number, externalTron?: string | null): { terms: TermsV2Call; b58ByHex: Map<string, string> } {
  const map = tronLegMapOf(c);
  const order: Role[] = ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'];
  const present = order.map(r => c.participants.find(p => p.role === r)).filter(Boolean) as DealCommitment['participants'];
  if (present.length < 2) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'escrow V2 exige ao menos Vendedor e Comprador');
  const b58ByHex = new Map<string, string>();
  const walletOf = (p: DealCommitment['participants'][number]): Hex => {
    const b58 = isTronB58(p.address) ? p.address
      : map.external && p.role === map.externalSide && externalTron && isTronB58(externalTron) ? externalTron
      : null;
    if (!b58) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `participante ${p.role} sem endereço Tron para o escrow V2 (carteira multichain sem conta Tron?)`);
    const hex = tronAddrToHex20(b58).toLowerCase() as Hex;
    b58ByHex.set(hex, b58);
    return hex;
  };
  const legOf = (i: number | null) => (i === null ? null : c.legs.find(l => l.index === i) ?? null);
  const sellerLeg = legOf(map.sellerLegIndex);
  const buyerLeg = legOf(map.buyerLegIndex);
  const externalLeg = map.external ? c.legs.find(l => l.escrowChain !== 'tron') : null;
  const clamp = (n: number) => Math.min(Math.max(0, n), 10000);
  const commissionBps = clamp(c.terms.pricing.commissionBps);
  const buyerBase = BigInt((buyerLeg ?? externalLeg)?.amountBase ?? '0');
  const hasPm1 = present.some(p => p.role === 'PAYMASTER_1');
  const cTotal = (map.externalSide === 'BUYER' || !hasPm1) ? 0n : commissionAmountOf(buyerBase, clamp(c.terms.pricing.discountBps), commissionBps);
  const split = c.terms.pricing.commissionSplitBps ?? [];
  const pm2Bps = split[1] ?? 0;
  const commissionPm2 = commissionBps > 0 ? cTotal * BigInt(clamp(pm2Bps)) / BigInt(commissionBps) : 0n;
  const commissionPm1 = cTotal - commissionPm2;
  // Perna Tron com contractOrMint NULO = TRX NATIVO → sentinela EIP-7528; address(0) = perna EXTERNA.
  const assetOf = (leg: typeof sellerLeg): Hex => (leg ? (leg.asset.contractOrMint ? tronAddrToHex20(leg.asset.contractOrMint).toLowerCase() as Hex : NATIVE_ASSET_EVM as Hex) : ZERO20);
  const terms: TermsV2Call = {
    participants: present.map(p => ({ wallet: walletOf(p), role: ROLE_TO_ONCHAIN[p.role] })),
    sellerAsset: assetOf(sellerLeg),
    sellerAmount: BigInt((sellerLeg ?? externalLeg)?.amountBase ?? '0'),
    buyerAsset: assetOf(buyerLeg),
    buyerAmount: buyerBase,
    platformFeeBps: c.feeBps, commissionBps, discountBps: clamp(c.terms.pricing.discountBps), slippageBps: clamp(c.terms.pricing.maxSlippageBps),
    createdAt: BigInt(chainNow), expiresAt: BigInt(chainNow + 2400), termsVersion: 2,
    nonce: deriveNonce(c.dealId, c.revision, c.dealNonce),
    htlcHash: map.external ? ('0x' + c.htlcHash) as Hex : ZERO32,
    commissionPm1, commissionPm2,
    dealType: 0, swapRouter: ZERO20, minAmountOut: 0n,
  };
  return { terms, b58ByHex };
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

export class VerumTronV2Adapter implements SettlementAdapter, ParticipantStepProvider {
  readonly chain: ChainRef;
  readonly escrowV2: string;       // T-base58
  readonly escrowHex20: Hex;       // 20 bytes p/ domínio EIP-712 e tradeId
  private twMod: Promise<{ TronWeb: new (o: { fullHost: string; privateKey?: string }) => TronWebV2 }> | null = null;
  private executor: Promise<TronWebV2> | null = null;
  constructor(private readonly cfg: TronSettings, private readonly keyring: TronDevKeyring | null, private readonly deps: VerumAdapterDeps & { tronAddressOf?: (dealId: string, role: Role) => Promise<string | null> }) {
    if (!cfg.escrowV2) throw new DomainError('INVALID_INPUT', 'TRON_ESCROW_V2_ADDRESS ausente');
    this.escrowV2 = cfg.escrowV2;
    this.escrowHex20 = tronAddrToHex20(cfg.escrowV2).toLowerCase() as Hex;
    this.chain = { network: 'tron', chainId: String(cfg.chainId) };
  }

  private mod() { this.twMod ??= import('tronweb') as never; return this.twMod!; }
  private async twExecutor(): Promise<TronWebV2> {
    this.executor ??= (async () => new (await this.mod()).TronWeb({ fullHost: this.cfg.fullHost, privateKey: this.cfg.executorKey }))();
    return this.executor;
  }
  private async twAs(pkHex: string): Promise<TronWebV2> {
    return new (await this.mod()).TronWeb({ fullHost: this.cfg.fullHost, privateKey: pkHex.replace(/^0x/, '') });
  }
  private async escrowWith(tw: TronWebV2) { return tw.contract(ESCROW_V2_ABI as unknown[], this.escrowV2); }

  private fail(op: string, e: unknown): never {
    const msg = e instanceof Error ? e.message : String(e);
    if (/fetch|network|ECONN|503|429|timeout/i.test(msg)) throw new DomainError('ADAPTER_UNAVAILABLE', `RPC Tron indisponível (${op})`);
    if (/Expired/i.test(msg)) throw new DomainError('DEAL_EXPIRED', `expirada on-chain (${op})`);
    throw new DomainError('SETTLEMENT_FAILED', `${op} on-chain falhou: ${(msg.split('\n')[0] ?? msg).slice(0, 400)}`);
  }
  private ref(tx: string): TxRef { return { chain: 'tron', ref: tx, submittedAt: Date.now() }; }
  private devKey(addressB58: string): Hex {
    const pk = this.keyring?.privateKeyByAddress(addressB58);
    if (!pk) throw new DomainError('SETTLEMENT_FAILED', `sem chave dev para ${addressB58} — em produção o participante envia a própria transação`);
    return pk;
  }
  private async chainNow(): Promise<number> {
    const tw = await this.twExecutor();
    return Math.floor((await tw.trx.getCurrentBlock()).block_header.raw_data.timestamp / 1000);
  }
  /** Envia uma escrita no escrow como um signer específico e espera a confirmação. */
  private async writeAs(pkHex: string, fn: string, args: unknown[], callValueSun = 0n): Promise<string> {
    const tw = await this.twAs(pkHex);
    const esc = await this.escrowWith(tw);
    const txid = await esc[fn]!(...args).send({ feeLimit: FEE_LIMIT_SUN, callValue: Number(callValueSun) });
    await this.waitConfirmed(fn, String(txid));
    return String(txid);
  }
  private async waitConfirmed(label: string, txid: string, timeoutMs = 120_000): Promise<void> {
    const tw = await this.twExecutor();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const info = await tw.trx.getTransactionInfo(txid).catch(() => ({} as { id?: string }));
      if (info && (info as { id?: string }).id) {
        const r = (info as { receipt?: { result?: string } }).receipt?.result;
        if (r && r !== 'SUCCESS') throw new Error(`${label} falhou on-chain (${r}): ${txid}`);
        return;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error(`${label} não confirmada em ${timeoutMs / 1000}s: ${txid}`);
  }
  private async rawTrade(tradeId: string): Promise<RawTradeV2Tron> {
    const esc = await this.escrowWith(await this.twExecutor());
    const t = await esc.getTradeV2!(tradeId).call() as Record<string, unknown>;
    const hex = (v: unknown): Hex => String(v).toLowerCase() as Hex;
    // Endereços nas leituras do tronweb podem vir como '41…' (21 bytes TVM), '0x…' ou base58 —
    // normaliza SEMPRE para hex20 0x… (o formato dos termos/domínio EIP-712).
    const addr = (v: unknown): Hex => {
      const s = String(v);
      if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase() as Hex;
      if (/^41[0-9a-fA-F]{40}$/.test(s)) return ('0x' + s.slice(2).toLowerCase()) as Hex;
      if (isTronB58(s)) return tronAddrToHex20(s).toLowerCase() as Hex;
      return s.toLowerCase() as Hex;
    };
    const big = (v: unknown): bigint => BigInt(String(v));
    return {
      termsHash: hex(t.termsHash), state: Number(t.state), nextIdx: Number(t.nextIdx),
      sellerExternal: Boolean(t.sellerExternal), sellerDeposited: Boolean(t.sellerDeposited), buyerDeposited: Boolean(t.buyerDeposited),
      feeAmount: big(t.feeAmount ?? 0), seller: addr(t.seller), paymaster01: addr(t.paymaster01), paymaster02: addr(t.paymaster02), buyer: addr(t.buyer),
      sellerAsset: addr(t.sellerAsset), sellerAmount: big(t.sellerAmount ?? 0), buyerAsset: addr(t.buyerAsset), buyerAmount: big(t.buyerAmount ?? 0),
      expiresAt: big(t.expiresAt ?? 0), htlcHash: hex(t.htlcHash ?? ZERO32), commissionPm1: big(t.commissionPm1 ?? 0), commissionPm2: big(t.commissionPm2 ?? 0),
    };
  }
  private async binding(dealId: string): Promise<{ meta: VerumMeta & { buyerLegIndex?: number; sellerLegIndex?: number }; dealHash: string }> {
    const b = await bindingOf(this.deps, dealId, 'tron');
    if (!b) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `deal ${dealId} sem registro on-chain (meta ausente)`);
    return b as never;
  }
  /** callValue (SUN) exigido no signV2 do papel: perna TRX NATIVA do depositante. */
  private signValueOf(role: OnchainRole, t: RawTradeV2Tron): bigint {
    if (role === OnchainRole.SELLER && !t.sellerExternal && isNativeAsset(t.sellerAsset)) return t.sellerAmount + t.feeAmount;
    if (role === OnchainRole.BUYER && isNativeAsset(t.buyerAsset)) return t.buyerAmount + t.commissionPm1 + t.commissionPm2 + (t.sellerExternal ? t.feeAmount : 0n);
    return 0n;
  }
  /** base58 da carteira hex20 nos termos — conversão PURA (base58check de 0x41‖hex20). */
  private b58Of(hex20: string): string { return evmToTronAddress(hex20 as Hex); }

  capabilities(): AdapterCapabilities { return { escrowNN: true, htlc: false, verifiableSigSchemes: ['secp256k1'], finalityConfirmations: this.cfg.confirmations, nativeCode: 'TRX' }; }
  escrowAddress(): string { return this.escrowV2; }
  validateAddress(address: string): boolean { return isTronB58(address); }
  async estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { return op === 'settle' ? '2.80' : '1.40'; }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = Date.now(); const reasons: string[] = [];
    try {
      if (asset.network !== 'tron' || asset.chainId !== this.chain.chainId) return { ok: false, reasons: ['rede/chainId não corresponde ao adaptador'], observed: { exists: false }, checkedAt };
      // TRX NATIVO (perna nativa do escrow V2): sem contrato para auditar — só os decimais (6).
      if (asset.contractOrMint === null) {
        if (asset.decimals !== 6) return { ok: false, reasons: [`TRX nativo tem 6 decimais (registro: ${asset.decimals})`], observed: { exists: true, decimals: 6, symbol: 'TRX' }, checkedAt };
        return { ok: true, reasons: [], observed: { exists: true, decimals: 6, symbol: 'TRX', standard: 'NATIVE' }, checkedAt };
      }
      const tw = await this.twExecutor();
      const token = await tw.contract([
        { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
        { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      ], asset.contractOrMint);
      const decimals = Number(String(await token.decimals!().call()));
      const symbol = String(await token.symbol!().call());
      if (decimals !== asset.decimals) reasons.push(`decimals divergente (on-chain ${decimals}, registro ${asset.decimals})`);
      const esc = await this.escrowWith(tw);
      const active = Boolean(await esc.isTokenActive!(tronAddrToHex20(asset.contractOrMint)).call());
      if (!active) reasons.push('token não está ACTIVE no registry on-chain do escrow V2');
      return { ok: reasons.length === 0, reasons, observed: { exists: true, decimals, symbol, standard: 'TRC-20' }, checkedAt };
    } catch (e) { this.fail('verifyAsset', e); }
  }
  async getBalance(address: string, asset: CanonicalAsset): Promise<bigint> {
    try {
      const tw = await this.twExecutor();
      if (!asset.contractOrMint) return BigInt(await tw.trx.getBalance(address));
      const token = await tw.contract([{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }], asset.contractOrMint);
      return BigInt(String(await token.balanceOf!(address).call()));
    } catch (e) { this.fail('getBalance', e); }
  }

  async registerDeal(c: DealCommitment): Promise<RegisterResult> {
    const existing = await bindingOf(this.deps, c.dealId, 'tron');
    if (existing) {
      const t = await this.rawTrade(existing.meta.tradeId).catch(() => null);
      if (t && t.state !== StateV2.NONE) return { ...this.ref('registered'), meta: existing.meta };
    }
    try {
      const now = await this.chainNow();
      const map = tronLegMapOf(c);
      const extRole = map.externalSide === 'BUYER' ? 'BUYER' as const : 'SELLER' as const;
      const extPart = c.participants.find(pp => pp.role === extRole);
      const externalTron = extPart && isTronB58(extPart.address) ? extPart.address : await this.deps.tronAddressOf?.(c.dealId, extRole) ?? null;
      const { terms, b58ByHex } = buildVerumTermsV2Tron(c, now, externalTron);
      await this.assertAssetsAcceptable(terms);
      // Hash pelo PRÓPRIO contrato (pure) — zero divergência de EIP-712 off-chain.
      const esc = await this.escrowWith(await this.twExecutor());
      const termsHash = String(await esc.hashTermsV2!(this.termsTuple(terms)).call()).toLowerCase() as Hex;
      const tradeId = computeTradeIdEvm(this.cfg.chainId, this.escrowHex20, termsHash);
      const atts: { validUntil: bigint; signature: Hex }[] = [];
      for (const p of terms.participants) {
        const a: WalletAttestation = await signWalletAttestationEvm(this.cfg.attestorKey, this.cfg.chainId, this.escrowHex20, p.wallet, Number(terms.expiresAt) + 3600);
        atts.push({ validUntil: BigInt(a.validUntil), signature: a.signature as Hex });
      }
      // Criador: PM1 quando presente; bilateral → primeiro participante. msg.sender = criador.
      const pm1 = terms.participants.find(p => p.role === OnchainRole.PAYMASTER_01);
      const creatorHex = (pm1 ?? terms.participants[0] as { wallet: Hex }).wallet;
      const creatorB58 = b58ByHex.get(creatorHex) ?? this.b58Of(creatorHex);
      if (!creatorB58) throw new DomainError('SETTLEMENT_FAILED', `criador ${creatorHex} sem endereço Tron conhecido`);
      const tx = await this.writeAs(this.devKey(creatorB58), 'createTradeV2', [this.termsTuple(terms), atts.map(a => [a.validUntil, a.signature])]);
      const meta = { tradeId, termsHash, onChainCreatedAt: Number(terms.createdAt), onChainExpiresAt: Number(terms.expiresAt), buyerLegIndex: map.buyerLegIndex ?? -1, sellerLegIndex: map.sellerLegIndex ?? -1 } as unknown as VerumMeta;
      return { ...this.ref(tx), meta };
    } catch (e) { if (e instanceof DomainError) throw e; this.fail('register', e); }
  }
  /** Tuple posicional dos TermsV2 (ordem do struct no contrato) — tronweb/ethers encodam por posição. */
  private termsTuple(t: TermsV2Call): unknown[] {
    return [
      t.participants.map(p => [p.wallet, p.role]),
      t.sellerAsset, t.sellerAmount, t.buyerAsset, t.buyerAmount,
      t.platformFeeBps, t.commissionBps, t.discountBps, t.slippageBps,
      t.createdAt, t.expiresAt, t.termsVersion, t.nonce, t.htlcHash,
      t.commissionPm1, t.commissionPm2, t.dealType, t.swapRouter, t.minAmountOut,
    ];
  }
  /** Falha cedo e claro se o escrow não aceitar os ativos (sentinela nativa dispensa registry). */
  private async assertAssetsAcceptable(terms: TermsV2Call): Promise<void> {
    const esc = await this.escrowWith(await this.twExecutor());
    for (const asset of [terms.sellerAsset, terms.buyerAsset]) {
      if (/^0x0{40}$/i.test(asset) || isNativeAsset(asset)) continue;
      if (!(await esc.isTokenActive!(asset).call().then(Boolean, () => false))) {
        throw new DomainError('SETTLEMENT_NOT_ALLOWED', `Token ${asset} não está habilitado no escrow V2 Tron (${this.escrowV2}) — o owner precisa rodar addToken antes de operar este ativo.`);
      }
    }
  }

  /** Depósito mesa = approve TRC-20 da perna on-chain do papel (nativa: gate de saldo em SUN). */
  async deposit(dealId: string, legIndex: number, _from: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    try {
      const t = await this.rawTrade(b.meta.tradeId);
      if (t.state === StateV2.NONE) throw new DomainError('FUNDING_REQUIRED', 'Operação ainda não registrada on-chain — aguarde o createTradeV2 do Pay Master 1', { registerPending: true, tradeId: b.meta.tradeId });
      const isSellerLeg = Number(b.meta.sellerLegIndex) === legIndex && Number(b.meta.sellerLegIndex) >= 0;
      const onRole = isSellerLeg ? OnchainRole.SELLER : OnchainRole.BUYER;
      if (t.state !== StateV2.SIGNING || CANON.indexOf(onRole) < t.nextIdx) return this.ref('deposited');
      const ownerHex = isSellerLeg ? t.seller : t.buyer;
      const ownerB58 = this.b58Of(ownerHex);
      const token = isSellerLeg ? t.sellerAsset : t.buyerAsset;
      const base = isSellerLeg ? t.sellerAmount : t.buyerAmount + t.commissionPm1 + t.commissionPm2;
      const paysFee = isSellerLeg ? !t.sellerExternal : t.sellerExternal;
      const due = base + (paysFee ? t.feeAmount : 0n);
      const tw = await this.twExecutor();
      if (isNativeAsset(token)) {
        // Perna NATIVA: sem approve — o TRX entra como callValue no signV2. Gate de saldo apenas.
        if (!ownerB58) return this.ref('native-onsign');
        const balance = BigInt(await tw.trx.getBalance(ownerB58));
        if (balance >= due) return this.ref('native-onsign');
        throw new DomainError('FUNDING_REQUIRED', `Saldo de TRX insuficiente para o pagamento na assinatura: tem ${balance} SUN, precisa ${due} SUN (+ taxas)`, { owner: ownerB58, balance: balance.toString(), due: due.toString(), native: true });
      }
      const tokenB58 = (tw as unknown as { address: { fromHex(h: string): string } }).address.fromHex('41' + token.slice(2));
      const tokenC = await tw.contract([{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] }], tokenB58);
      const ownerArg = ownerB58 ?? ('41' + ownerHex.slice(2));
      const allowance = BigInt(String(await tokenC.allowance!(ownerArg, this.escrowV2).call()));
      if (allowance >= due) return this.ref('approved');
      if (!ownerB58 || !this.keyring?.privateKeyByAddress(ownerB58)) {
        throw new DomainError('FUNDING_REQUIRED', `Autorize o token pela carteira (approve): liberado ${allowance} de ${due} necessários`, { token: tokenB58, owner: ownerB58 ?? ownerHex, allowance: allowance.toString(), due: due.toString(), spender: this.escrowV2 });
      }
      const twOwner = await this.twAs(this.devKey(ownerB58));
      const tokenW = await twOwner.contract([{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] }], tokenB58);
      const txid = String(await tokenW.approve!(this.escrowV2, due.toString()).send({ feeLimit: 100_000_000 }));
      await this.waitConfirmed('approve', txid);
      return this.ref(txid);
    } catch (e) { if (e instanceof DomainError && e.code === 'FUNDING_REQUIRED') throw e; this.fail('deposit', e); }
  }

  /** Submete signV2 na vez do papel (idempotente quando o papel já avançou o nextIdx on-chain). */
  async recordApproval(dealId: string, sig: ApprovalSignature): Promise<TxRef | null> {
    const b = await this.binding(dealId);
    const role = ROLE_TO_ONCHAIN[sig.role];
    try {
      const t = await this.rawTrade(b.meta.tradeId);
      if (t.state !== StateV2.SIGNING || CANON.indexOf(role) < t.nextIdx) return null;
      const now = await this.chainNow();
      const deadline = Math.min(now + 300, Number(t.expiresAt));
      // Assinante on-chain: a carteira Tron registrada nos TermsV2 (vendedor de BTC assina com ela).
      const walletHex = role === OnchainRole.SELLER ? t.seller : role === OnchainRole.BUYER ? t.buyer : role === OnchainRole.PAYMASTER_01 ? t.paymaster01 : t.paymaster02;
      const signerB58 = isTronB58(sig.signer) ? sig.signer : this.b58Of(walletHex);
      if (!signerB58) throw new DomainError('SETTLEMENT_FAILED', `sem endereço Tron para o assinante ${sig.signer}`);
      const pk = this.devKey(signerB58);
      const approval = await signApprovalEvm(pk, this.cfg.chainId, this.escrowHex20, b.meta.tradeId as Hex, b.meta.termsHash as Hex, role, deadline);
      // SELLER/BUYER precisam ser msg.sender (depósito embutido; nativa vai no callValue);
      // PMs são relayáveis pelo executor.
      const senderPk = role === OnchainRole.SELLER || role === OnchainRole.BUYER ? pk : ('0x' + this.cfg.executorKey) as Hex;
      const value = this.signValueOf(role, t);
      const tx = await this.writeAs(senderPk, 'signV2', [b.meta.tradeId, BigInt(deadline), approval.signature], value);
      return this.ref(tx);
    } catch (e) { if (e instanceof DomainError) throw e; this.fail(`recordApproval:${sig.role}`, e); }
  }

  /** settleV2 único liquida a(s) perna(s) desta rede; com HTLC a preimage É obrigatória. */
  async settle(dealId: string, _legIndex: number, _signatures: ApprovalSignature[], preimage?: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    const t = await this.rawTrade(b.meta.tradeId);
    if (t.state === StateV2.SETTLED) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'trade já liquidada on-chain');
    if (t.htlcHash !== ZERO32 && !/^[0-9a-f]{64}$/.test(preimage ?? '')) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'settleV2 com HTLC exige a preimage (sha256) do swap');
    try { return this.ref(await this.writeAs('0x' + this.cfg.executorKey, 'settleV2', [b.meta.tradeId, t.htlcHash !== ZERO32 ? '0x' + preimage : '0x'])); }
    catch (e) { this.fail('settle', e); }
  }

  async refund(dealId: string, _legIndex: number): Promise<TxRef> {
    const b = await this.binding(dealId);
    const t = await this.rawTrade(b.meta.tradeId);
    if (t.state === StateV2.REFUNDED) return this.ref('refunded');
    const now = await this.chainNow();
    if (t.state !== StateV2.EXPIRED && now < Number(t.expiresAt)) {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'reembolso on-chain só após a expiração da janela de 40 min (retryRefunds completa)');
    }
    try { return this.ref(await this.writeAs('0x' + this.cfg.executorKey, t.state === StateV2.EXPIRED ? 'refundV2' : 'expireAndRefundV2', [b.meta.tradeId])); }
    catch (e) { this.fail('refund', e); }
  }

  async supersede(_dealId: string, _revision: number): Promise<TxRef | null> { return null; }

  async getDealState(dealId: string): Promise<OnChainDealState> {
    const bound = await bindingOf(this.deps, dealId, 'tron');
    if (!bound) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
    try {
      const t = await this.rawTrade(bound.meta.tradeId);
      const state = t.state as StateV2;
      const sellerLegIndex = Number(bound.meta.sellerLegIndex ?? 0);
      const buyerLegIndex = Number(bound.meta.buyerLegIndex ?? 1);
      const deposits: Record<number, string> = {};
      if (t.sellerDeposited && !t.sellerExternal && sellerLegIndex >= 0) deposits[sellerLegIndex] = t.sellerAmount.toString();
      if (t.buyerDeposited && buyerLegIndex >= 0) deposits[buyerLegIndex] = t.buyerAmount.toString();
      const settledLegs: Record<number, string> = {};
      if (state === StateV2.SETTLED) { if (!t.sellerExternal && sellerLegIndex >= 0) settledLegs[sellerLegIndex] = 'onchain-settled'; if (buyerLegIndex >= 0) settledLegs[buyerLegIndex] = 'onchain-settled'; }
      return {
        status: statusOfV2(state, t.sellerDeposited || t.buyerDeposited), revision: bound.revision, deposits, settledLegs,
        dealHash: bound.dealHash || undefined, expiresAt: Number(t.expiresAt), tradeId: bound.meta.tradeId,
      };
    } catch (e) { this.fail('getDealState', e); }
  }

  async waitFinal(ref: string): Promise<TxStatus> {
    if (!/^[0-9a-fA-F]{64}$/.test(ref)) return { ref, status: 'final', confirmations: this.cfg.confirmations };
    try {
      const tw = await this.twExecutor();
      const info = await tw.trx.getTransactionInfo(ref);
      if (!info?.id) return { ref, status: 'pending', confirmations: 0 };
      if (info.receipt?.result && info.receipt.result !== 'SUCCESS') return { ref, status: 'reverted', confirmations: 1, error: info.receipt.result };
      const latest = (await tw.trx.getCurrentBlock()).block_header.raw_data.number;
      const confirmations = Math.max(1, latest - (info.blockNumber ?? latest) + 1);
      return { ref, status: confirmations >= this.cfg.confirmations ? 'final' : 'included', confirmations };
    } catch { return { ref, status: 'pending', confirmations: 0 }; }
  }

  /** Preimage revelada NO CONTRATO (storage após settleV2) — é o gatilho do claim do BTC. */
  async revealedPreimage(dealId: string): Promise<string | null> {
    const bound = await bindingOf(this.deps, dealId, 'tron');
    if (!bound) return null;
    try {
      const esc = await this.escrowWith(await this.twExecutor());
      const pre = String(await esc.revealedPreimage!(bound.meta.tradeId).call());
      return pre && pre !== '0x' && pre !== 'null' ? pre.replace(/^0x/, '').toLowerCase() : null;
    } catch { return null; }
  }

  /* ---------- fluxo de carteira real (/v1/deals/:id/onchain-tx) ---------- */
  /** TypedData Approval (domínio TIP-712: chainId Tron + escrow V2 hex20) + approve TRC-20 pendente. */
  async buildParticipantStep(dealId: string, role: Role, signer: string): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    const onRole = ROLE_TO_ONCHAIN[role];
    const t = await this.rawTrade(b.meta.tradeId);
    if (t.state !== StateV2.SIGNING || CANON.indexOf(onRole) < t.nextIdx) return { kind: 'done', tradeId: b.meta.tradeId, state: t.state };
    const now = await this.chainNow();
    const deadline = Math.min(now + 300, Number(t.expiresAt));
    let approve: Record<string, string> | null = null;
    const valueSun = this.signValueOf(onRole, t);
    if ((onRole === OnchainRole.SELLER && !t.sellerExternal || onRole === OnchainRole.BUYER) && valueSun === 0n) {
      const isSeller = onRole === OnchainRole.SELLER;
      const token = isSeller ? t.sellerAsset : t.buyerAsset;
      const base = isSeller ? t.sellerAmount : t.buyerAmount + t.commissionPm1 + t.commissionPm2;
      const due = base + ((isSeller ? !t.sellerExternal : t.sellerExternal) ? t.feeAmount : 0n);
      const tw = await this.twExecutor();
      const tokenB58 = tw.address.fromHex('41' + token.slice(2));
      const tokenC = await tw.contract([{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] }], tokenB58);
      const allowance = BigInt(String(await tokenC.allowance!(signer, this.escrowV2).call()));
      if (allowance < due) approve = { token: tokenB58, spender: this.escrowV2, amount: due.toString() };
    }
    return {
      kind: 'tron', chainId: this.cfg.chainId, escrow: this.escrowV2, escrowHex: this.escrowHex20, fn: 'signV2', deadline, approve,
      callValueSun: valueSun.toString(),
      typedData: { domain: { ...evmDomain(this.cfg.chainId, this.escrowHex20), chainId: this.cfg.chainId }, types: APPROVAL_TYPES, primaryType: 'Approval', message: { tradeId: b.meta.tradeId, termsHash: b.meta.termsHash, role: onRole, deadline: String(deadline) } },
      relayable: onRole === OnchainRole.PAYMASTER_01 || onRole === OnchainRole.PAYMASTER_02,
    };
  }
  /** PMs: relaya pelo executor. Seller/Buyer: devolve os parâmetros do signV2 p/ a carteira enviar. */
  async submitParticipantStep(dealId: string, role: Role, _signer: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    const onRole = ROLE_TO_ONCHAIN[role];
    const signature = String(body.signature ?? '');
    const deadline = Number(body.deadline ?? 0);
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !deadline) throw new DomainError('INVALID_INPUT', 'esperado { signature (65 bytes hex), deadline }');
    if (onRole === OnchainRole.PAYMASTER_01 || onRole === OnchainRole.PAYMASTER_02) {
      try { const tx = await this.writeAs('0x' + this.cfg.executorKey, 'signV2', [b.meta.tradeId, BigInt(deadline), signature]); return { kind: 'relayed', txHash: tx }; }
      catch (e) { this.fail(`participantStep:${role}`, e); }
    }
    const t = await this.rawTrade(b.meta.tradeId);
    return {
      kind: 'tronTx', contract: this.escrowV2, functionSelector: 'signV2(bytes32,uint64,bytes)',
      parameters: [
        { type: 'bytes32', value: b.meta.tradeId }, { type: 'uint64', value: String(deadline) }, { type: 'bytes', value: signature },
      ],
      feeLimit: FEE_LIMIT_SUN, callValue: Number(this.signValueOf(onRole, t)),
    };
  }
}
