/**
 * VerumSolanaAdapter — porta SettlementAdapter sobre o programa verum_otc (Anchor) em devnet/localnet.
 * Reutiliza o SolanaChainAdapter vendorado (src/onchain/router/adapters/solana.ts) para construir
 * as instruções sem o client Anchor; em dev/demo as TRANSAÇÕES de papel são assinadas server-side
 * com as keypairs ed25519 do keyring demo (signerFor). O executor paga as taxas das txs relayáveis.
 *
 * Diferenças Solana: cada papel assina a PRÓPRIA transação (não há assinatura off-chain Approval);
 * atestados são PDAs criados pelo attestor (ensureAttested, idempotente via init_if_needed).
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { CanonicalAsset, ChainRef, Role } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { TradeState, Role as OnchainRole, type ChainId, type Terms as VerumTerms, type Signature as VerumSignature } from '../../onchain/types.js';
import { computeFee } from '../../onchain/core/index.js';
import { SolanaChainAdapter, anchorDiscriminator, findPda, associatedTokenAddress } from '../../onchain/router/adapters/solana.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, ParticipantStepProvider, RegisterResult, SettlementAdapter, TxRef, TxStatus } from '../types.js';
import { buildVerumTerms, statusFromTradeState, depositsOf, bindingOf, ROLE_TO_ONCHAIN, ROLE_ALREADY_ADVANCED, type VerumAdapterDeps, type VerumMeta } from './common.js';
import type { SolanaSettings } from '../../config.js';

const SOLANA_CLUSTER: Record<string, string> = { '101': 'mainnet-beta', '102': 'testnet', '103': 'devnet' };
const MIN_LAMPORTS = 5_000_000;      // 0,005 SOL
const TOPUP_LAMPORTS = 50_000_000;   // 0,05 SOL por recarga (executor pré-financia papéis dev)

export function parseKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(trimmed, 'base64')));
}

export class VerumSolanaAdapter implements SettlementAdapter, ParticipantStepProvider {
  readonly chain: ChainRef;
  private readonly inner: SolanaChainAdapter;
  private readonly conn: Connection;
  private readonly executor: Keypair;
  private readonly attestor: Keypair;
  constructor(
    private readonly cfg: SolanaSettings,
    /** Keypair ed25519 do participante dev/demo (null = carteira real; tx volta ao frontend). */
    private readonly signerFor: (address: string) => Uint8Array | null,
    private readonly deps: VerumAdapterDeps,
  ) {
    this.chain = { network: 'solana', chainId: SOLANA_CLUSTER[cfg.chainId] ?? cfg.chainId };
    this.executor = parseKeypair(cfg.executorKeypair);
    this.attestor = parseKeypair(cfg.attestorKeypair);
    this.conn = new Connection(cfg.rpcUrl, 'confirmed');
    this.inner = new SolanaChainAdapter(
      { chainId: Number(cfg.chainId) as ChainId, kind: 'SOLANA', name: `solana-${this.chain.chainId}`, nativeSymbol: 'SOL', nativeDecimals: 9, isMainnet: cfg.chainId === '101', escrowAddress: cfg.programId, rpcUrl: cfg.rpcUrl, explorerUrl: '', requiredConfirmations: cfg.confirmations },
      { connection: this.conn, executorKeypair: this.executor },
    );
  }

  private fail(op: string, e: unknown): never {
    const msg = e instanceof Error ? e.message : String(e);
    if (/fetch|network|ECONN|503|429|timeout/i.test(msg)) throw new DomainError('ADAPTER_UNAVAILABLE', `RPC Solana indisponível (${op})`);
    if (/Expired/i.test(msg)) throw new DomainError('DEAL_EXPIRED', `expirada on-chain (${op})`);
    throw new DomainError('SETTLEMENT_FAILED', `${op} on-chain falhou: ${msg.replace(/\s*\n\s*/g, ' · ').slice(0, 600)}`);
  }
  private ref(tx: string): TxRef { return { chain: 'solana', ref: tx, submittedAt: Date.now() }; }
  private keypairOf(address: string): Keypair {
    const sk = this.signerFor(address);
    if (!sk) throw new DomainError('SETTLEMENT_FAILED', `sem keypair dev para ${address} — fluxo de carteira real usa /v1/deals/:id/onchain-tx`);
    return Keypair.fromSecretKey(sk);
  }
  private async ensureLamports(pubkey: PublicKey): Promise<void> {
    if (await this.conn.getBalance(pubkey, 'confirmed') >= MIN_LAMPORTS) return;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: this.executor.publicKey, toPubkey: pubkey, lamports: TOPUP_LAMPORTS }));
    await this.sendSigned(tx, [this.executor], this.executor.publicKey);
  }
  private async sendSigned(tx: Transaction, signers: Keypair[], feePayer: PublicKey): Promise<string> {
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await this.conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(...signers);
    let sig: string;
    try { sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' }); }
    catch (e) {
      const logs = (e as { logs?: string[] }).logs ?? [];
      throw new Error(`${(e as Error).message} | logs: ${logs.slice(-6).join(' ;; ')}`, { cause: e });
    }
    const conf = await this.inner.waitForConfirmation(sig, 90_000);
    if (conf.status !== 'CONFIRMED') throw new Error(`tx não confirmada (${conf.status}): ${conf.reason ?? sig}`);
    return sig;
  }
  /** Reconstrói as instruções de uma UnsignedTx do adapter vendorado e envia com os signers dados. */
  private async submitUnsigned(unsigned: { payload: Record<string, unknown> }, signers: Keypair[], feePayer: PublicKey): Promise<string> {
    const p = unsigned.payload as { programId: string; instruction: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
    const ix = new TransactionInstruction({
      programId: new PublicKey(p.programId),
      keys: p.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(p.instruction, 'base64'),
    });
    return this.sendSigned(new Transaction().add(ix), signers, feePayer);
  }
  private async verumTermsOf(dealId: string, c: DealCommitment | null, meta: VerumMeta): Promise<VerumTerms> {
    // Terms são determinísticos: commitment + createdAt persistido em meta ⇒ mesmos bytes/tradeId.
    if (c) return buildVerumTerms(c, Number(this.cfg.chainId) as ChainId, this.cfg.programId, meta.onChainCreatedAt);
    const deal = await this.deps.getDeal(dealId) as unknown as { terms: DealCommitment['terms']; hash: { dealHash: string; pricingHash: string; routeHash: string; domainHash: string }; revision: number } | null;
    if (!deal?.terms || !deal.hash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos indisponíveis para reconstruir a trade Solana');
    const t = deal.terms;
    const commitment: DealCommitment = { dealId, revision: deal.revision, dealHash: deal.hash.dealHash, expiresAt: t.expiresAt, participants: t.participants, legs: t.legs, pricingHash: deal.hash.pricingHash, routeHash: deal.hash.routeHash, domainHash: deal.hash.domainHash, dealNonce: t.dealNonce, feeBps: t.pricing.platformFeeBps, treasury: '', terms: t };
    return buildVerumTerms(commitment, Number(this.cfg.chainId) as ChainId, this.cfg.programId, meta.onChainCreatedAt);
  }

  capabilities(): AdapterCapabilities { return { escrowNN: true, htlc: false, verifiableSigSchemes: ['ed25519'], finalityConfirmations: this.cfg.confirmations, nativeCode: 'SOL' }; }
  escrowAddress(): string { return this.cfg.programId; }
  validateAddress(address: string): boolean { try { new PublicKey(address); return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address); } catch { return false; } }
  async estimateCostUsd(_op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { return '0.02'; }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = Date.now();
    try {
      if (asset.network !== 'solana') return { ok: false, reasons: ['rede não corresponde ao adaptador'], observed: { exists: false }, checkedAt };
      if (!asset.contractOrMint) return { ok: false, reasons: ['escrow Verum é só-token (sem SOL nativo)'], observed: { exists: false }, checkedAt };
      const info = await this.conn.getAccountInfo(new PublicKey(asset.contractOrMint), 'confirmed');
      if (!info) return { ok: false, reasons: ['mint inexistente no cluster'], observed: { exists: false }, checkedAt };
      const decimals = info.data[44] as number;
      const reasons: string[] = [];
      if (decimals !== asset.decimals) reasons.push(`decimals divergente (on-chain ${decimals}, registro ${asset.decimals})`);
      try { await this.inner.tokenProgramFor(asset.contractOrMint); } catch (e) { reasons.push((e as Error).message); }
      return { ok: reasons.length === 0, reasons, observed: { exists: true, decimals, standard: info.owner.toBase58().startsWith('Tokenz') ? 'Token-2022' : 'SPL' }, checkedAt };
    } catch (e) { this.fail('verifyAsset', e); }
  }
  async getBalance(address: string, asset: CanonicalAsset): Promise<bigint> {
    try {
      if (!asset.contractOrMint) return BigInt(await this.conn.getBalance(new PublicKey(address), 'confirmed'));
      const program = await this.inner.tokenProgramFor(asset.contractOrMint);
      const ata = associatedTokenAddress(new PublicKey(address), new PublicKey(asset.contractOrMint), program);
      try { return BigInt((await this.conn.getTokenAccountBalance(ata, 'confirmed')).value.amount); } catch { return 0n; }
    } catch (e) { this.fail('getBalance', e); }
  }

  /** Atestados = PDAs ["attest", wallet] criados pelo attestor (idempotente: init_if_needed renova). */
  async ensureAttested(wallets: string[], validUntil: number): Promise<void> {
    const programId = new PublicKey(this.cfg.programId);
    const [config] = findPda(programId, ['config']);
    for (const w of wallets) {
      const wallet = new PublicKey(w);
      const [attestation] = findPda(programId, ['attest', wallet.toBytes()]);
      const data = Buffer.concat([
        Buffer.from(anchorDiscriminator('global', 'attest_wallet')), wallet.toBuffer(),
        (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(validUntil)); return b; })(),
      ]);
      const ix = new TransactionInstruction({ programId, data, keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: this.attestor.publicKey, isSigner: true, isWritable: true },
        { pubkey: attestation, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ] });
      await this.sendSigned(new Transaction().add(ix), [this.attestor], this.attestor.publicKey);
    }
  }

  async registerDeal(c: DealCommitment): Promise<RegisterResult> {
    const existing = await bindingOf(this.deps, c.dealId, 'solana');
    if (existing) {
      const t = await this.inner.getTrade(existing.meta.tradeId).catch(() => null);
      if (t && t.state !== TradeState.NONE) return { ...this.ref('registered'), meta: existing.meta };
    }
    try {
      const now = await this.inner.now();
      const terms = buildVerumTerms(c, Number(this.cfg.chainId) as ChainId, this.cfg.programId, now);
      if (terms.sellerAmount > 0xffffffffffffffffn || terms.buyerAmount > 0xffffffffffffffffn) throw new DomainError('INVALID_INPUT', 'quantias excedem u64 (Solana)');
      const { tradeId, termsHash } = this.inner.computeIds(terms);
      await this.ensureAttested([terms.seller, terms.paymaster01, terms.paymaster02, terms.buyer], terms.expiresAt + 3600);
      const pm1 = this.keypairOf(terms.paymaster01);
      await this.ensureLamports(pm1.publicKey);
      const unsigned = await this.inner.buildCreateTrade(terms, [
        { wallet: terms.seller, validUntil: terms.expiresAt + 3600, signature: '' }, { wallet: terms.paymaster01, validUntil: terms.expiresAt + 3600, signature: '' },
        { wallet: terms.paymaster02, validUntil: terms.expiresAt + 3600, signature: '' }, { wallet: terms.buyer, validUntil: terms.expiresAt + 3600, signature: '' },
      ]);
      const tx = await this.submitUnsigned(unsigned, [pm1], pm1.publicKey);
      const meta: VerumMeta = { tradeId, termsHash, onChainCreatedAt: terms.createdAt, onChainExpiresAt: terms.expiresAt };
      return { ...this.ref(tx), meta };
    } catch (e) { this.fail('register', e); }
  }

  /** Solana não tem approve: o depósito mesa é checagem de saldo (custódia real em seller_sign/buyer_sign). */
  async deposit(dealId: string, legIndex: number, from: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    try {
      const terms = await this.verumTermsOf(dealId, null, b.meta);
      const seller = legIndex === 0;
      const mint = seller ? terms.sellerAsset : terms.buyerAsset;
      const need = seller ? terms.sellerAmount + computeFee(terms.sellerAmount, terms.platformFeeBps) : terms.buyerAmount;
      const bal = await this.getBalance(from, { contractOrMint: mint, network: 'solana' } as CanonicalAsset);
      if (bal < need) throw new DomainError('FUNDING_REQUIRED', `saldo insuficiente na ATA (${bal} < ${need})`);
      return this.ref('balance-verified');
    } catch (e) { if (e instanceof DomainError) throw e; this.fail('deposit', e); }
  }

  /** A assinatura do papel é a PRÓPRIA transação (seller_sign deposita principal+fee; buyer_sign deposita e arma o settle). */
  async recordApproval(dealId: string, sig: ApprovalSignature): Promise<TxRef | null> {
    const b = await this.binding(dealId);
    const role = ROLE_TO_ONCHAIN[sig.role as Role];
    try {
      const trade = await this.inner.getTrade(b.meta.tradeId);
      if (!trade) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'trade inexistente on-chain');
      const already: Record<OnchainRole, TradeState[]> = {
        [OnchainRole.SELLER]: [TradeState.SELLER_SIGNED, TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.PAYMASTER_01]: [TradeState.PAYMASTER_01_SIGNED, TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.PAYMASTER_02]: [TradeState.PAYMASTER_02_SIGNED, TradeState.READY_TO_SETTLE, TradeState.SETTLED],
        [OnchainRole.BUYER]: [TradeState.READY_TO_SETTLE, TradeState.SETTLED],
      };
      if (already[role].includes(trade.state)) return null;
      const terms = await this.verumTermsOf(dealId, null, b.meta);
      const now = await this.inner.now();
      const deadline = Math.min(now + 300, terms.expiresAt);
      const approval: VerumSignature = { role, signer: sig.signer, tradeId: b.meta.tradeId, termsHash: b.meta.termsHash, deadline, signature: '' };
      const unsigned = await this.inner.buildSign(terms, b.meta.tradeId, approval);
      const signer = this.keypairOf(sig.signer);
      await this.ensureLamports(signer.publicKey);
      // PMs: executor paga a taxa (relayer), papel só assina. Seller/Buyer pagam a própria tx.
      const relayed = role === OnchainRole.PAYMASTER_01 || role === OnchainRole.PAYMASTER_02;
      const signers = relayed ? [this.executor, signer] : [signer];
      const tx = await this.submitUnsigned(unsigned, signers, relayed ? this.executor.publicKey : signer.publicKey);
      return this.ref(tx);
    } catch (e) { if (e instanceof DomainError) throw e; this.fail(`recordApproval:${sig.role}`, e); }
  }

  async settle(dealId: string, _legIndex: number, _signatures: ApprovalSignature[], _preimage?: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    const trade = await this.inner.getTrade(b.meta.tradeId);
    if (trade?.state === TradeState.SETTLED) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'trade já liquidada on-chain');
    try {
      const unsigned = await this.inner.buildSettle(b.meta.tradeId);
      const r = await this.inner.submitAsExecutor(unsigned);
      const conf = await this.inner.waitForConfirmation(r.txHash, 90_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`settle não confirmado (${conf.status}): ${conf.reason ?? r.txHash}`);
      return this.ref(r.txHash);
    } catch (e) { this.fail('settle', e); }
  }

  async refund(dealId: string, _legIndex: number): Promise<TxRef> {
    const b = await this.binding(dealId);
    const trade = await this.inner.getTrade(b.meta.tradeId);
    if (!trade) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'trade inexistente on-chain');
    if (trade.state === TradeState.REFUNDED) return this.ref('refunded');
    const now = await this.inner.now();
    if (trade.state !== TradeState.EXPIRED && now < trade.expiresAt) {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'reembolso on-chain só após a expiração da janela de 40 min (retryRefunds completa)');
    }
    try {
      if (trade.state !== TradeState.EXPIRED) {
        const exp = await this.inner.submitAsExecutor(await this.inner.buildExpire(b.meta.tradeId));
        await this.inner.waitForConfirmation(exp.txHash, 90_000);
      }
      const r = await this.inner.submitAsExecutor(await this.inner.buildRefund(b.meta.tradeId));
      const conf = await this.inner.waitForConfirmation(r.txHash, 90_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`refund não confirmado (${conf.status})`);
      return this.ref(r.txHash);
    } catch (e) { this.fail('refund', e); }
  }

  async supersede(_dealId: string, _revision: number): Promise<TxRef | null> { return null; }

  async getDealState(dealId: string): Promise<OnChainDealState> {
    const bound = await bindingOf(this.deps, dealId, 'solana');
    if (!bound) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
    try {
      const t = await this.inner.getTrade(bound.meta.tradeId);
      if (!t) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} };
      const terms = await this.verumTermsOf(dealId, null, bound.meta);
      const settledLegs: Record<number, string> = t.state === TradeState.SETTLED ? { 0: 'onchain-settled', 1: 'onchain-settled' } : {};
      return {
        status: statusFromTradeState(t.state, t.sellerDeposited, t.buyerDeposited), revision: bound.revision,
        deposits: depositsOf(t.sellerDeposited, t.buyerDeposited, terms.sellerAmount, terms.buyerAmount), settledLegs,
        dealHash: bound.dealHash || undefined, expiresAt: t.expiresAt, tradeId: bound.meta.tradeId,
      };
    } catch (e) { this.fail('getDealState', e); }
  }

  async waitFinal(ref: string): Promise<TxStatus> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(ref)) return { ref, status: 'final', confirmations: this.cfg.confirmations };
    const conf = await this.inner.waitForConfirmation(ref, 60_000);
    if (conf.status === 'CONFIRMED') return { ref, status: 'final', confirmations: conf.confirmations };
    if (conf.status === 'FAILED') return { ref, status: 'reverted', confirmations: conf.confirmations, error: conf.reason };
    return { ref, status: 'pending', confirmations: 0 };
  }
  async revealedPreimage(_dealId: string): Promise<string | null> { return null; }

  private async binding(dealId: string): Promise<{ meta: VerumMeta; dealHash: string }> {
    const b = await bindingOf(this.deps, dealId, 'solana');
    if (!b) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `deal ${dealId} sem registro on-chain (meta ausente)`);
    return b;
  }

  /* ---------- fluxo de carteira real (/v1/deals/:id/onchain-tx) ---------- */
  /** Na Solana o papel assina a PRÓPRIA transação: devolve a tx base64 fresca para a Verum Wallet assinar. */
  async buildParticipantStep(dealId: string, role: Role, signer: string): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    const onRole = ROLE_TO_ONCHAIN[role];
    const trade = await this.inner.getTrade(b.meta.tradeId);
    if (!trade) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'trade inexistente on-chain');
    if (ROLE_ALREADY_ADVANCED[onRole].includes(trade.state)) return { kind: 'done', tradeId: b.meta.tradeId, state: trade.state };
    const terms = await this.verumTermsOf(dealId, null, b.meta);
    const now = await this.inner.now();
    const deadline = Math.min(now + 300, terms.expiresAt);
    const unsigned = await this.inner.buildSign(terms, b.meta.tradeId, { role: onRole, signer, tradeId: b.meta.tradeId, termsHash: b.meta.termsHash, deadline, signature: '' });
    const p = unsigned.payload as { transactionBase64: string; recentBlockhash: string; lastValidBlockHeight: number };
    return { kind: 'solana', tradeId: b.meta.tradeId, deadline, transactionBase64: p.transactionBase64, recentBlockhash: p.recentBlockhash, lastValidBlockHeight: p.lastValidBlockHeight };
  }
  /** Recebe a transação assinada pela carteira e faz o broadcast + confirmação. */
  async submitParticipantStep(_dealId: string, _role: Role, _signer: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const b64 = String(body.signedTransactionBase64 ?? '');
    if (!b64) throw new DomainError('INVALID_INPUT', 'esperado { signedTransactionBase64 }');
    try {
      const raw = Buffer.from(b64, 'base64');
      const sig = await this.conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
      const conf = await this.inner.waitForConfirmation(sig, 90_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`tx não confirmada (${conf.status}): ${conf.reason ?? sig}`);
      return { kind: 'broadcast', txHash: sig };
    } catch (e) { this.fail('participantStep', e); }
  }
}
