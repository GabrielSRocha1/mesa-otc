/**
 * VerumEvmAdapter — porta SettlementAdapter da mesa sobre o escrow canônico VerumOTCEscrowEVM
 * (contratos verum-otc-onchain) em anvil/Sepolia.
 *
 * Mapeamento semântico (ponte mesa ↔ contrato):
 *  - registerDeal  → createTrade (enviado pela EOA do PM1; attestor assina 4 WalletAttestations)
 *  - deposit       → ERC20 approve(escrow, valor[+fee]) — a custódia real acontece no sign
 *  - recordApproval→ sellerSign/paymaster01Sign/paymaster02Sign/buyerSign (seller/buyer depositam aqui)
 *  - settle        → settle(tradeId) único pelo keeper (swap atômico das duas legs)
 *  - refund        → expireAndRefund após a janela de 40 min; antes dela fica pendente
 * Stateless: tudo re-derivável de deal.onChain[*].meta (tradeId/termsHash) + RPC — serverless-safe.
 */
import { createPublicClient, createWalletClient, http, defineChain, keccak256, isAddress, type Abi, type Chain, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { CanonicalAsset, ChainRef } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { TradeState, Role as OnchainRole, type ChainId, type WalletAttestation } from '../../onchain/types.js';
import { computeFee } from '../../onchain/core/index.js';
import { hashTermsEvm, computeTradeIdEvm, signApprovalEvm, signWalletAttestationEvm, evmDomain, APPROVAL_TYPES } from '../../onchain/crypto/index.js';
import { ESCROW_ABI, EvmCalldata, toEvmTermsTuple, toEvmAttestationTuples, type EvmTermsTuple } from '../../onchain/router/adapters/evm.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, ParticipantStepProvider, RegisterResult, SettlementAdapter, TxRef, TxStatus } from '../types.js';
import type { Role } from '../../domain/types.js';
import { buildVerumTerms, statusFromTradeState, depositsOf, bindingOf, ROLE_TO_ONCHAIN, ROLE_ALREADY_ADVANCED, type VerumAdapterDeps, type VerumMeta } from './common.js';
import type { VerumEvmDevKeyring } from './keyring.js';
import type { VerumEvmSettings } from '../../config.js';

type Hex = `0x${string}`;
const MIN_GAS_WEI = 5n * 10n ** 15n;
const TOPUP_WEI = 2n * 10n ** 16n;
const SIGN_FN: Record<OnchainRole, 'sellerSign' | 'paymaster01Sign' | 'paymaster02Sign' | 'buyerSign'> = {
  [OnchainRole.SELLER]: 'sellerSign', [OnchainRole.PAYMASTER_01]: 'paymaster01Sign', [OnchainRole.PAYMASTER_02]: 'paymaster02Sign', [OnchainRole.BUYER]: 'buyerSign',
};
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
] as const satisfies Abi;

interface RawTrade { terms: EvmTermsTuple; termsHash: Hex; state: number; sellerDeposited: boolean; buyerDeposited: boolean; feeCollected: boolean; feeAmount: bigint; settledAt: bigint; expiredAt: bigint }

export class VerumEvmAdapter implements SettlementAdapter, ParticipantStepProvider {
  readonly chain: ChainRef;
  private readonly viemChain: Chain;
  private readonly pub: PublicClient;
  private readonly keeper: PrivateKeyAccount;
  private readonly keeperWallet: WalletClient;
  constructor(private readonly cfg: VerumEvmSettings, private readonly keyring: VerumEvmDevKeyring | null, private readonly deps: VerumAdapterDeps) {
    this.chain = { network: 'ethereum', chainId: String(cfg.chainId) };
    this.viemChain = defineChain({ id: cfg.chainId, name: `verum-evm-${cfg.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
    this.pub = createPublicClient({ chain: this.viemChain, transport: http(cfg.rpcUrl) });
    this.keeper = privateKeyToAccount(cfg.keeperKey);
    this.keeperWallet = createWalletClient({ chain: this.viemChain, transport: http(cfg.rpcUrl), account: this.keeper });
  }

  private fail(op: string, e: unknown): never {
    const msg = e instanceof Error ? e.message : String(e);
    const short = /reverted with the following reason:\s*([^\n]+)/.exec(msg)?.[1] ?? /Error: (\w+)\(/.exec(msg)?.[1] ?? msg.split('\n')[0];
    if (/timeout|fetch|network|ECONN|503|429/i.test(msg)) throw new DomainError('ADAPTER_UNAVAILABLE', `RPC EVM indisponível (${op})`);
    if (/TradeExpired|Expired/.test(msg)) throw new DomainError('DEAL_EXPIRED', `expirada on-chain (${op})`);
    throw new DomainError('SETTLEMENT_FAILED', `${op} on-chain falhou: ${short}`);
  }
  private view<T>(fn: string, args: unknown[] = []): Promise<T> { return this.pub.readContract({ address: this.cfg.escrow, abi: ESCROW_ABI, functionName: fn, args }) as Promise<T>; }
  private async write(fn: string, args: unknown[], account: PrivateKeyAccount = this.keeper): Promise<string> {
    const wallet = account === this.keeper ? this.keeperWallet : createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account });
    const hash = await wallet.writeContract({ address: this.cfg.escrow, abi: ESCROW_ABI, functionName: fn, args, account, chain: this.viemChain });
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
  private async rawTrade(tradeId: string): Promise<RawTrade> { return this.view<RawTrade>('getTrade', [tradeId as Hex]); }
  private ref(tx: string): TxRef { return { chain: 'ethereum', ref: tx, submittedAt: Date.now() }; }

  capabilities(): AdapterCapabilities { return { escrowNN: true, htlc: false, verifiableSigSchemes: ['secp256k1'], finalityConfirmations: this.cfg.confirmations, nativeCode: 'ETH' }; }
  escrowAddress(): string { return this.cfg.escrow; }
  validateAddress(address: string): boolean { return /^0x[0-9a-fA-F]{40}$/.test(address) && isAddress(address); }
  async estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { return op === 'settle' ? '3.50' : '1.20'; }
  /** Mint dev (MockERC20 permissionless; keeper paga o gás). */
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
      if (!active) reasons.push('token não está ACTIVE no registry on-chain do escrow');
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
    // Idempotência: se esta revisão já registrou (meta persistida) e a trade existe, devolve referência sintética.
    const existing = await bindingOf(this.deps, c.dealId, 'ethereum');
    if (existing) {
      const t = await this.rawTrade(existing.meta.tradeId).catch(() => null);
      if (t && Number(t.state) !== TradeState.NONE) return { ...this.ref('registered'), meta: existing.meta };
    }
    try {
      const now = await this.chainNow();
      const terms = buildVerumTerms(c, this.cfg.chainId as ChainId, this.cfg.escrow, now);
      const termsHash = hashTermsEvm(terms);
      const tradeId = computeTradeIdEvm(this.cfg.chainId, this.cfg.escrow, termsHash);
      // Attestor assina os 4 atestados (ordem fixa: seller, pm1, pm2, buyer) — validade cobre a janela da trade.
      const atts: WalletAttestation[] = [];
      for (const w of [terms.seller, terms.paymaster01, terms.paymaster02, terms.buyer]) {
        atts.push(await signWalletAttestationEvm(this.cfg.attestorKey, this.cfg.chainId, this.cfg.escrow, w, terms.expiresAt + 3600));
      }
      const pm1 = this.devAccount(terms.paymaster01);
      await this.ensureGas(pm1.address);
      const tx = await this.write('createTrade', [toEvmTermsTuple(terms), toEvmAttestationTuples(atts)], pm1);
      const meta: VerumMeta = { tradeId, termsHash, onChainCreatedAt: terms.createdAt, onChainExpiresAt: terms.expiresAt };
      return { ...this.ref(tx), meta };
    } catch (e) { this.fail('register', e); }
  }

  /** Depósito mesa = approve ERC20 (a custódia real acontece em sellerSign/buyerSign). */
  async deposit(dealId: string, legIndex: number, _from: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    try {
      const t = await this.rawTrade(b.meta.tradeId);
      const seller = legIndex === 0;
      const owner = seller ? t.terms.seller : t.terms.buyer;
      const token = seller ? t.terms.sellerAsset : t.terms.buyerAsset;
      const due = seller ? t.terms.sellerAmount + computeFee(t.terms.sellerAmount, t.terms.platformFeeBps) : t.terms.buyerAmount;
      const allowance = await this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, this.cfg.escrow] }) as bigint;
      if (allowance >= due) return this.ref('approved');
      const acc = this.devAccount(owner);
      await this.ensureGas(acc.address);
      const wallet = createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account: acc });
      const h = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [this.cfg.escrow, due], account: acc, chain: this.viemChain });
      await this.pub.waitForTransactionReceipt({ hash: h });
      return this.ref(h);
    } catch (e) { this.fail('deposit', e); }
  }

  /** Submete o passo on-chain da vez (assinatura EIP-712 Approval verificada pelo contrato). */
  async recordApproval(dealId: string, sig: ApprovalSignature): Promise<TxRef | null> {
    const b = await this.binding(dealId);
    const role = ROLE_TO_ONCHAIN[sig.role];
    try {
      const t = await this.rawTrade(b.meta.tradeId);
      const state = Number(t.state) as TradeState;
      // Idempotência: papel já avançou o estado (reprocesso serverless) → no-op.
      const already: Record<OnchainRole, TradeState[]> = {
        [OnchainRole.SELLER]: [TradeState.SELLER_SIGNED, TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.PAYMASTER_01]: [TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.PAYMASTER_02]: [TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.BUYER]: [TradeState.READY_TO_SETTLE, TradeState.SETTLED],
      };
      if (already[role].includes(state)) return null;
      const now = await this.chainNow();
      const deadline = Math.min(now + 300, Number(t.terms.expiresAt));
      const pk = this.keyring?.privateKeyByAddress(sig.signer);
      if (!pk) throw new DomainError('SETTLEMENT_FAILED', `sem chave dev para ${sig.signer} — fluxo de carteira real usa /v1/deals/:id/onchain-tx`);
      const approval = await signApprovalEvm(pk, this.cfg.chainId, this.cfg.escrow, b.meta.tradeId as Hex, b.meta.termsHash as Hex, role, deadline);
      // seller/buyer enviam a própria tx (msg.sender obrigatório); PMs são relayáveis pelo keeper.
      const sender = role === OnchainRole.SELLER || role === OnchainRole.BUYER ? this.devAccount(sig.signer) : this.keeper;
      if (sender !== this.keeper) await this.ensureGas(sender.address);
      const tx = await this.write(SIGN_FN[role], [b.meta.tradeId as Hex, BigInt(deadline), approval.signature as Hex], sender);
      return this.ref(tx);
    } catch (e) { this.fail(`recordApproval:${sig.role}`, e); }
  }

  /** settle(tradeId) único liquida as DUAS legs; a leg 1 nunca gera segunda tx (settledLegs reporta ambas). */
  async settle(dealId: string, _legIndex: number, _signatures: ApprovalSignature[], _preimage?: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    const t = await this.rawTrade(b.meta.tradeId);
    if (Number(t.state) === TradeState.SETTLED) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'trade já liquidada on-chain');
    try { return this.ref(await this.write('settle', [b.meta.tradeId as Hex])); }
    catch (e) { this.fail('settle', e); }
  }

  /** Após a janela de 40 min: expireAndRefund devolve os principais às origens. Antes dela → pendente. */
  async refund(dealId: string, _legIndex: number): Promise<TxRef> {
    const b = await this.binding(dealId);
    const t = await this.rawTrade(b.meta.tradeId);
    const state = Number(t.state) as TradeState;
    if (state === TradeState.REFUNDED) return this.ref('refunded');
    const now = await this.chainNow();
    if (state !== TradeState.EXPIRED && now < Number(t.terms.expiresAt)) {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'reembolso on-chain só após a expiração da janela de 40 min (retryRefunds completa)');
    }
    try { return this.ref(await this.write(state === TradeState.EXPIRED ? 'refund' : 'expireAndRefund', [b.meta.tradeId as Hex])); }
    catch (e) { this.fail('refund', e); }
  }

  async supersede(_dealId: string, _revision: number): Promise<TxRef | null> { return null; } // inexistente on-chain: unwind é expire+refund

  async getDealState(dealId: string): Promise<OnChainDealState> {
    const bound = await bindingOf(this.deps, dealId, 'ethereum');
    if (!bound) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
    try {
      const t = await this.rawTrade(bound.meta.tradeId);
      const state = Number(t.state) as TradeState;
      const status = statusFromTradeState(state, t.sellerDeposited, t.buyerDeposited);
      const settledLegs: Record<number, string> = state === TradeState.SETTLED ? { 0: 'onchain-settled', 1: 'onchain-settled' } : {};
      return {
        status, revision: bound.revision, deposits: depositsOf(t.sellerDeposited, t.buyerDeposited, t.terms.sellerAmount, t.terms.buyerAmount), settledLegs,
        dealHash: bound.dealHash || undefined, expiresAt: Number(t.terms.expiresAt), tradeId: bound.meta.tradeId,
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
  async revealedPreimage(_dealId: string): Promise<string | null> { return null; }

  private async binding(dealId: string): Promise<{ meta: VerumMeta; dealHash: string }> {
    const b = await bindingOf(this.deps, dealId, 'ethereum');
    if (!b) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `deal ${dealId} sem registro on-chain (meta ausente)`);
    return b;
  }

  /* ---------- fluxo de carteira real (/v1/deals/:id/onchain-tx) ---------- */
  /** O que o participante deve assinar/enviar agora: approve ERC20 pendente + typedData Approval. */
  async buildParticipantStep(dealId: string, role: Role, signer: string): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    const onRole = ROLE_TO_ONCHAIN[role];
    const t = await this.rawTrade(b.meta.tradeId);
    const state = Number(t.state) as TradeState;
    if (ROLE_ALREADY_ADVANCED[onRole].includes(state)) return { kind: 'done', tradeId: b.meta.tradeId, state };
    const now = await this.chainNow();
    const deadline = Math.min(now + 300, Number(t.terms.expiresAt));
    let approve: Record<string, string> | null = null;
    if (onRole === OnchainRole.SELLER || onRole === OnchainRole.BUYER) {
      const seller = onRole === OnchainRole.SELLER;
      const token = seller ? t.terms.sellerAsset : t.terms.buyerAsset;
      const due = seller ? t.terms.sellerAmount + computeFee(t.terms.sellerAmount, t.terms.platformFeeBps) : t.terms.buyerAmount;
      const allowance = await this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [signer as Hex, this.cfg.escrow] }) as bigint;
      if (allowance < due) approve = { token, spender: this.cfg.escrow, amount: due.toString() };
    }
    return {
      kind: 'evm', chainId: this.cfg.chainId, escrow: this.cfg.escrow, fn: SIGN_FN[onRole], deadline, approve,
      typedData: { domain: { ...evmDomain(this.cfg.chainId, this.cfg.escrow), chainId: this.cfg.chainId }, types: APPROVAL_TYPES, primaryType: 'Approval', message: { tradeId: b.meta.tradeId, termsHash: b.meta.termsHash, role: onRole, deadline: String(deadline) } },
      relayable: onRole === OnchainRole.PAYMASTER_01 || onRole === OnchainRole.PAYMASTER_02, // PMs: o keeper envia a tx; seller/buyer enviam da própria carteira
    };
  }
  /** PMs: relaya a tx pelo keeper. Seller/Buyer: devolve o txRequest (to/data) para a carteira enviar (msg.sender obrigatório). */
  async submitParticipantStep(dealId: string, role: Role, _signer: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    const onRole = ROLE_TO_ONCHAIN[role];
    const signature = String(body.signature ?? '');
    const deadline = Number(body.deadline ?? 0);
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !deadline) throw new DomainError('INVALID_INPUT', 'esperado { signature (65 bytes hex), deadline }');
    const data = EvmCalldata.sign({ role: onRole, signer: _signer, tradeId: b.meta.tradeId, termsHash: b.meta.termsHash, deadline, signature });
    if (onRole === OnchainRole.PAYMASTER_01 || onRole === OnchainRole.PAYMASTER_02) {
      try { const tx = await this.write(SIGN_FN[onRole], [b.meta.tradeId as Hex, BigInt(deadline), signature as Hex]); return { kind: 'relayed', txHash: tx }; }
      catch (e) { this.fail(`participantStep:${role}`, e); }
    }
    return { kind: 'txRequest', txRequest: { to: this.cfg.escrow, data, value: '0', chainId: this.cfg.chainId } };
  }
}
