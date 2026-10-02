/**
 * VerumTronAdapter — porta SettlementAdapter sobre o VerumOTCEscrowTron (Nile). Reutiliza o
 * TronChainAdapter vendorado (calldata idêntica à EVM; EIP-712 sobre endereços hex 20 bytes com
 * o chainId Tron injetado). `tronweb` é importado SOB DEMANDA: sem o grupo TRON_* o bundle do
 * Vercel nunca o carrega. Em dev o TronDevKeyring assina os passos dos papéis; o executor relaya
 * PMs/settle/expire/refund.
 */
import type { CanonicalAsset, ChainRef } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { TradeState, Role as OnchainRole, type ChainId, type WalletAttestation } from '../../onchain/types.js';
import { computeFee } from '../../onchain/core/index.js';
import { signApprovalEvm, signWalletAttestationEvm, evmToTronAddress } from '../../onchain/crypto/index.js';
import { TronChainAdapter, TRON_ESCROW_ABI, tronAddrToHex20, type TronWebLike } from '../../onchain/router/adapters/tron.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, RegisterResult, SettlementAdapter, TxRef, TxStatus } from '../types.js';
import { buildVerumTerms, statusFromTradeState, depositsOf, bindingOf, ROLE_TO_ONCHAIN, type VerumAdapterDeps, type VerumMeta } from './common.js';
import type { TronDevKeyring } from './keyring.js';
import type { TronSettings } from '../../config.js';

type Hex = `0x${string}`;
const FEE_LIMIT_SUN = 150_000_000;

interface TronRuntime { tw: TronWebLike & { address: { fromPrivateKey(k: string): string } }; inner: TronChainAdapter; executorAddress: string }

export class VerumTronAdapter implements SettlementAdapter {
  readonly chain: ChainRef;
  private runtime: Promise<TronRuntime> | null = null;
  constructor(private readonly cfg: TronSettings, private readonly keyring: TronDevKeyring | null, private readonly deps: VerumAdapterDeps) {
    this.chain = { network: 'tron', chainId: String(cfg.chainId) };
  }

  private rt(): Promise<TronRuntime> {
    this.runtime ??= (async () => {
      const mod = await import('tronweb') as unknown as { TronWeb: new (o: { fullHost: string; privateKey?: string }) => TronRuntime['tw'] };
      const tw = new mod.TronWeb({ fullHost: this.cfg.fullHost, privateKey: this.cfg.executorKey });
      const executorAddress = tw.address.fromPrivateKey(this.cfg.executorKey);
      const inner = new TronChainAdapter(
        { chainId: this.cfg.chainId as ChainId, kind: 'TRON', name: `tron-${this.cfg.chainId}`, nativeSymbol: 'TRX', nativeDecimals: 6, isMainnet: this.cfg.chainId === 728126428, escrowAddress: this.cfg.escrow, rpcUrl: this.cfg.fullHost, explorerUrl: '', requiredConfirmations: this.cfg.confirmations },
        { tronWeb: tw, abi: TRON_ESCROW_ABI, executorPrivateKey: this.cfg.executorKey, executorAddress, feeLimitSun: FEE_LIMIT_SUN },
      );
      return { tw, inner, executorAddress };
    })();
    return this.runtime;
  }

  private fail(op: string, e: unknown): never {
    const msg = e instanceof Error ? e.message : String(e);
    if (/fetch|network|ECONN|503|429|timeout/i.test(msg)) throw new DomainError('ADAPTER_UNAVAILABLE', `RPC Tron indisponível (${op})`);
    if (/Expired/i.test(msg)) throw new DomainError('DEAL_EXPIRED', `expirada on-chain (${op})`);
    throw new DomainError('SETTLEMENT_FAILED', `${op} on-chain falhou: ${msg.split('\n')[0]}`);
  }
  private ref(tx: string): TxRef { return { chain: 'tron', ref: tx, submittedAt: Date.now() }; }
  private devKey(address: string): Hex {
    const pk = this.keyring?.privateKeyByAddress(address) ?? this.keyring?.privateKeyByAddress(address.toLowerCase());
    if (!pk) throw new DomainError('SETTLEMENT_FAILED', `sem chave dev para ${address} — em produção o participante envia a própria transação`);
    return pk;
  }
  /** triggerSmartContract assinado por um participante específico (createTrade/sellerSign/buyerSign exigem msg.sender). */
  private async submitAs(key: Hex, issuerB58: string, contractB58: string, selector: string, params: { type: string; value: unknown }[]): Promise<string> {
    const { tw } = await this.rt();
    const built = await tw.transactionBuilder.triggerSmartContract(contractB58, selector, { feeLimit: FEE_LIMIT_SUN, callValue: 0 }, params, issuerB58);
    if (!built.result?.result) throw new Error(`triggerSmartContract falhou: ${built.result?.message ?? 'sem detalhes'}`);
    const signed = await tw.trx.sign(built.transaction, key.replace(/^0x/, ''));
    const sent = await tw.trx.sendRawTransaction(signed);
    if (!sent.result || !sent.txid) throw new Error(`broadcast falhou: ${sent.code ?? ''} ${sent.message ?? ''}`);
    const { inner } = await this.rt();
    const conf = await inner.waitForConfirmation(sent.txid, 120_000);
    if (conf.status !== 'CONFIRMED') throw new Error(`tx ${selector} não confirmada (${conf.status}): ${conf.reason ?? sent.txid}`);
    return sent.txid;
  }

  capabilities(): AdapterCapabilities { return { escrowNN: true, htlc: false, verifiableSigSchemes: ['secp256k1'], finalityConfirmations: this.cfg.confirmations, nativeCode: 'TRX' }; }
  escrowAddress(): string { return this.cfg.escrow; }
  validateAddress(address: string): boolean { return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address); }
  async estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { return op === 'settle' ? '2.80' : '1.40'; }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = Date.now();
    try {
      if (asset.network !== 'tron') return { ok: false, reasons: ['rede não corresponde ao adaptador'], observed: { exists: false }, checkedAt };
      if (!asset.contractOrMint) return { ok: false, reasons: ['escrow Verum é só-token (sem TRX nativo)'], observed: { exists: false }, checkedAt };
      const { tw, inner } = await this.rt();
      const token = tw.contract([
        { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
        { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      ], asset.contractOrMint);
      const reasons: string[] = [];
      const decimals = Number(((await token.decimals!().call()) as { toString(): string }).toString());
      const symbol = String(await token.symbol!().call());
      if (decimals !== asset.decimals) reasons.push(`decimals divergente (on-chain ${decimals}, registro ${asset.decimals})`);
      const escrow = tw.contract(TRON_ESCROW_ABI, this.cfg.escrow);
      const active = await escrow.isTokenActive!(tronAddrToHex20(asset.contractOrMint)).call() as boolean;
      if (!active) reasons.push('token não está ACTIVE no registry on-chain do escrow');
      void inner;
      return { ok: reasons.length === 0, reasons, observed: { exists: true, decimals, symbol, standard: 'TRC-20' }, checkedAt };
    } catch (e) { this.fail('verifyAsset', e); }
  }
  async getBalance(address: string, asset: CanonicalAsset): Promise<bigint> {
    try {
      const { tw } = await this.rt();
      if (!asset.contractOrMint) return BigInt(await tw.trx.getBalance(address));
      const token = tw.contract([{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }], asset.contractOrMint);
      return BigInt(((await token.balanceOf!(address).call()) as { toString(): string }).toString());
    } catch (e) { this.fail('getBalance', e); }
  }

  async registerDeal(c: DealCommitment): Promise<RegisterResult> {
    const existing = await bindingOf(this.deps, c.dealId, 'tron');
    if (existing) {
      const { inner } = await this.rt();
      const t = await inner.getTrade(existing.meta.tradeId).catch(() => null);
      if (t && t.state !== TradeState.NONE) return { ...this.ref('registered'), meta: existing.meta };
    }
    try {
      const { inner } = await this.rt();
      const now = await inner.now();
      const terms = buildVerumTerms(c, this.cfg.chainId as ChainId, this.cfg.escrow, now);
      const { tradeId, termsHash } = inner.computeIds(terms);
      const escrowHex = tronAddrToHex20(this.cfg.escrow);
      const atts: WalletAttestation[] = [];
      for (const w of [terms.seller, terms.paymaster01, terms.paymaster02, terms.buyer]) {
        atts.push(await signWalletAttestationEvm(this.cfg.attestorKey, this.cfg.chainId, escrowHex, tronAddrToHex20(w), terms.expiresAt + 3600));
      }
      const unsigned = await inner.buildCreateTrade(terms, atts as [WalletAttestation, WalletAttestation, WalletAttestation, WalletAttestation]);
      const p = unsigned.payload as { functionSelector: string; parameters: { type: string; value: unknown }[] };
      const pm1Key = this.devKey(terms.paymaster01);
      const tx = await this.submitAs(pm1Key, terms.paymaster01, this.cfg.escrow, p.functionSelector, p.parameters);
      const meta: VerumMeta = { tradeId, termsHash, onChainCreatedAt: terms.createdAt, onChainExpiresAt: terms.expiresAt };
      return { ...this.ref(tx), meta };
    } catch (e) { this.fail('register', e); }
  }

  /** Depósito mesa = approve TRC-20 pelo papel (custódia real em sellerSign/buyerSign). */
  async deposit(dealId: string, legIndex: number, _from: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    try {
      const terms = await this.termsOf(dealId, b.meta);
      const seller = legIndex === 0;
      const owner = seller ? terms.seller : terms.buyer;
      const token = seller ? terms.sellerAsset : terms.buyerAsset;
      const due = seller ? terms.sellerAmount + computeFee(terms.sellerAmount, terms.platformFeeBps) : terms.buyerAmount;
      const { tw } = await this.rt();
      const tokenC = tw.contract([{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] }], token);
      const allowance = BigInt(((await tokenC.allowance!(owner, this.cfg.escrow).call()) as { toString(): string }).toString());
      if (allowance >= due) return this.ref('approved');
      const tx = await this.submitAs(this.devKey(owner), owner, token, 'approve(address,uint256)', [
        { type: 'address', value: this.cfg.escrow }, { type: 'uint256', value: due.toString() },
      ]);
      return this.ref(tx);
    } catch (e) { this.fail('deposit', e); }
  }

  async recordApproval(dealId: string, sig: ApprovalSignature): Promise<TxRef | null> {
    const b = await this.binding(dealId);
    const role = ROLE_TO_ONCHAIN[sig.role];
    try {
      const { inner } = await this.rt();
      const trade = await inner.getTrade(b.meta.tradeId);
      if (!trade) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'trade inexistente on-chain');
      const already: Record<OnchainRole, TradeState[]> = {
        [OnchainRole.SELLER]: [TradeState.SELLER_SIGNED, TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.PAYMASTER_01]: [TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.PAYMASTER_02]: [TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.BUYER]: [TradeState.READY_TO_SETTLE, TradeState.SETTLED],
      };
      if (already[role].includes(trade.state)) return null;
      const terms = await this.termsOf(dealId, b.meta);
      const now = await inner.now();
      const deadline = Math.min(now + 300, terms.expiresAt);
      // Assinatura EIP-712 Approval com o chainId Tron e o escrow hex20 (domínio TIP-712 do contrato).
      const pk = this.devKey(sig.signer);
      const approval = await signApprovalEvm(pk, this.cfg.chainId, tronAddrToHex20(this.cfg.escrow), b.meta.tradeId as Hex, b.meta.termsHash as Hex, role, deadline);
      const unsigned = await inner.buildSign(terms, b.meta.tradeId, { ...approval, signer: sig.signer });
      const p = unsigned.payload as { functionSelector: string; parameters: { type: string; value: unknown }[] };
      if (role === OnchainRole.SELLER || role === OnchainRole.BUYER) {
        return this.ref(await this.submitAs(pk, sig.signer, this.cfg.escrow, p.functionSelector, p.parameters));
      }
      const r = await inner.submitAsExecutor(unsigned);
      const conf = await inner.waitForConfirmation(r.txHash, 120_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`${p.functionSelector} não confirmada (${conf.status})`);
      return this.ref(r.txHash);
    } catch (e) { if (e instanceof DomainError) throw e; this.fail(`recordApproval:${sig.role}`, e); }
  }

  async settle(dealId: string, _legIndex: number, _signatures: ApprovalSignature[], _preimage?: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    const { inner } = await this.rt();
    const trade = await inner.getTrade(b.meta.tradeId);
    if (trade?.state === TradeState.SETTLED) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'trade já liquidada on-chain');
    try {
      const r = await inner.submitAsExecutor(await inner.buildSettle(b.meta.tradeId));
      const conf = await inner.waitForConfirmation(r.txHash, 120_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`settle não confirmado (${conf.status}): ${conf.reason ?? r.txHash}`);
      return this.ref(r.txHash);
    } catch (e) { this.fail('settle', e); }
  }

  async refund(dealId: string, _legIndex: number): Promise<TxRef> {
    const b = await this.binding(dealId);
    const { inner } = await this.rt();
    const trade = await inner.getTrade(b.meta.tradeId);
    if (!trade) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'trade inexistente on-chain');
    if (trade.state === TradeState.REFUNDED) return this.ref('refunded');
    const now = await inner.now();
    if (trade.state !== TradeState.EXPIRED && now < trade.expiresAt) {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'reembolso on-chain só após a expiração da janela de 40 min (retryRefunds completa)');
    }
    try {
      if (trade.state !== TradeState.EXPIRED) {
        const exp = await inner.submitAsExecutor(await inner.buildExpire(b.meta.tradeId));
        await inner.waitForConfirmation(exp.txHash, 120_000);
      }
      const r = await inner.submitAsExecutor(await inner.buildRefund(b.meta.tradeId));
      const conf = await inner.waitForConfirmation(r.txHash, 120_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`refund não confirmado (${conf.status})`);
      return this.ref(r.txHash);
    } catch (e) { this.fail('refund', e); }
  }

  async supersede(_dealId: string, _revision: number): Promise<TxRef | null> { return null; }

  async getDealState(dealId: string): Promise<OnChainDealState> {
    const bound = await bindingOf(this.deps, dealId, 'tron');
    if (!bound) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
    try {
      const { inner } = await this.rt();
      const t = await inner.getTrade(bound.meta.tradeId);
      if (!t) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
      const terms = await this.termsOf(dealId, bound.meta);
      const settledLegs: Record<number, string> = t.state === TradeState.SETTLED ? { 0: 'onchain-settled', 1: 'onchain-settled' } : {};
      return {
        status: statusFromTradeState(t.state, t.sellerDeposited, t.buyerDeposited), revision: 0,
        deposits: depositsOf(t.sellerDeposited, t.buyerDeposited, terms.sellerAmount, terms.buyerAmount), settledLegs,
        dealHash: bound.dealHash || undefined, expiresAt: t.expiresAt, tradeId: bound.meta.tradeId,
      };
    } catch (e) { this.fail('getDealState', e); }
  }

  async waitFinal(ref: string): Promise<TxStatus> {
    if (!/^[0-9a-fA-F]{64}$/.test(ref)) return { ref, status: 'final', confirmations: this.cfg.confirmations };
    const { inner } = await this.rt();
    const conf = await inner.waitForConfirmation(ref, 60_000);
    if (conf.status === 'CONFIRMED') return { ref, status: 'final', confirmations: conf.confirmations };
    if (conf.status === 'FAILED') return { ref, status: 'reverted', confirmations: conf.confirmations, error: conf.reason };
    return { ref, status: 'pending', confirmations: 0 };
  }
  async revealedPreimage(_dealId: string): Promise<string | null> { return null; }

  /** Terms deterministicamente reconstruídos do Deal + meta (createdAt fixado no registro). */
  private async termsOf(dealId: string, meta: VerumMeta) {
    const deal = await this.deps.getDeal(dealId) as unknown as { terms: DealCommitment['terms']; hash: { dealHash: string; pricingHash: string; routeHash: string; domainHash: string }; revision: number } | null;
    if (!deal?.terms || !deal.hash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos indisponíveis para reconstruir a trade Tron');
    const t = deal.terms;
    const c: DealCommitment = { dealId, revision: deal.revision, dealHash: deal.hash.dealHash, expiresAt: t.expiresAt, participants: t.participants, legs: t.legs, pricingHash: deal.hash.pricingHash, routeHash: deal.hash.routeHash, domainHash: deal.hash.domainHash, dealNonce: t.dealNonce, feeBps: t.pricing.platformFeeBps, treasury: '', terms: t };
    return buildVerumTerms(c, this.cfg.chainId as ChainId, this.cfg.escrow, meta.onChainCreatedAt);
  }
  private async binding(dealId: string): Promise<{ meta: VerumMeta; dealHash: string }> {
    const b = await bindingOf(this.deps, dealId, 'tron');
    if (!b) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `deal ${dealId} sem registro on-chain (meta ausente)`);
    return b;
  }
}
export { evmToTronAddress };
