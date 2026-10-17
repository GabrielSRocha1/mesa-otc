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
import { sha256Hex, type CanonicalAsset, type ChainRef, type Role } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { TradeState, Role as OnchainRole, type ChainId, type Terms as VerumTerms, type Signature as VerumSignature } from '../../onchain/types.js';
import { computeFee } from '../../onchain/core/index.js';
import { SolanaChainAdapter, anchorDiscriminator, findPda, associatedTokenAddress, WSOL_MINT, TOKEN_PROGRAM_ID, EXTERNAL_ASSET } from '../../onchain/router/adapters/solana.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, ParticipantStepProvider, RegisterResult, SettlementAdapter, TxRef, TxStatus } from '../types.js';
import { buildVerumTerms, statusFromTradeState, depositsOf, bindingOf, ROLE_TO_ONCHAIN, ROLE_ALREADY_ADVANCED, type VerumAdapterDeps, type VerumMeta } from './common.js';
import type { SolanaSettings } from '../../config.js';

const SOLANA_CLUSTER: Record<string, string> = { '101': 'mainnet-beta', '102': 'testnet', '103': 'devnet' };
/** Sentinela de cadeira AUSENTE nos Terms (Pubkey::default) — mesa de 2–3 participantes. */
export const SOLANA_ABSENT_PM = '11111111111111111111111111111111';
const MIN_LAMPORTS = 5_000_000;      // 0,005 SOL
const TOPUP_LAMPORTS = 50_000_000;   // 0,05 SOL por recarga (executor pré-financia papéis dev)

export function parseKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(trimmed, 'base64')));
}

/** Deps do adapter Solana: além do Deal, resolve o endereço SOLANA de um papel pela carteira
 *  multichain da cadeira (ex.: comprador em rede EVM que RECEBE wSOL no claim do HTLC). */
export type VerumSolanaDeps = VerumAdapterDeps & { solAddressOf?: (dealId: string, role: Role) => Promise<string | null> };

/** Meta persistida da perna HTLC (deal.onChain.solana.meta) — `tradeId` carrega o htlcId.
 *  `htlcMint` null = SOL NATIVO (lamports no PDA; vault = o próprio PDA). */
interface HtlcMeta { tradeId: string; termsHash: string; onChainCreatedAt: number; onChainExpiresAt: number; htlcKind: 1; htlcHash: string; htlcMint: string | null; htlcAmount: string; htlcFunder: string; htlcRecipient: string; htlcVault: string }
const isHtlcMeta = (m: { tradeId: string } & Record<string, unknown>): m is HtlcMeta & Record<string, unknown> => (m as { htlcKind?: number }).htlcKind === 1;

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
    private readonly deps: VerumSolanaDeps,
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
    if (c) return buildVerumTerms(c, Number(this.cfg.chainId) as ChainId, this.cfg.programId, meta.onChainCreatedAt, SOLANA_ABSENT_PM, EXTERNAL_ASSET);
    const deal = await this.deps.getDeal(dealId) as unknown as { terms: DealCommitment['terms']; hash: { dealHash: string; pricingHash: string; routeHash: string; domainHash: string }; revision: number } | null;
    if (!deal?.terms || !deal.hash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos indisponíveis para reconstruir a trade Solana');
    const t = deal.terms;
    const commitment: DealCommitment = { dealId, revision: deal.revision, dealHash: deal.hash.dealHash, expiresAt: t.expiresAt, participants: t.participants, legs: t.legs, pricingHash: deal.hash.pricingHash, routeHash: deal.hash.routeHash, domainHash: deal.hash.domainHash, dealNonce: t.dealNonce, feeBps: t.pricing.platformFeeBps, treasury: '', terms: t };
    return buildVerumTerms(commitment, Number(this.cfg.chainId) as ChainId, this.cfg.programId, meta.onChainCreatedAt, SOLANA_ABSENT_PM, EXTERNAL_ASSET);
  }

  // htlc:true + escrowNN:true — o router liga a perna HTLC SÓ em rota cross-chain (vendedor aqui,
  // contrato em outra rede); na mesma rede continua o escrow N-de-N normal.
  capabilities(): AdapterCapabilities { return { escrowNN: true, htlc: true, verifiableSigSchemes: ['ed25519'], finalityConfirmations: this.cfg.confirmations, nativeCode: 'SOL' }; }
  escrowAddress(): string { return this.cfg.programId; }
  validateAddress(address: string): boolean { try { new PublicKey(address); return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address); } catch { return false; } }
  async estimateCostUsd(_op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { return '0.02'; }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = Date.now();
    try {
      if (asset.network !== 'solana') return { ok: false, reasons: ['rede não corresponde ao adaptador'], observed: { exists: false }, checkedAt };
      // SOL nativo é suportado na perna HTLC (htlc_lock_sol guarda lamports no PDA); o escrow
      // N-de-N direto continua só-token — essa restrição é validada na montagem dos termos.
      if (!asset.contractOrMint) return { ok: true, reasons: [], observed: { exists: true, decimals: 9, standard: 'native' }, checkedAt };
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
      let bal = 0n;
      try { bal = BigInt((await this.conn.getTokenAccountBalance(ata, 'confirmed')).value.amount); } catch { /* ATA inexistente */ }
      // wSOL: SOL nativo também conta (a tx de depósito embrulha o que faltar) — reserva p/ gás.
      if (asset.contractOrMint === WSOL_MINT) {
        const lamports = BigInt(await this.conn.getBalance(new PublicKey(address), 'confirmed'));
        const reserve = 10_000_000n; // 0.01 SOL
        bal += lamports > reserve ? lamports - reserve : 0n;
      }
      return bal;
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

  /** Perna HTLC cross-chain (ADR-v5): a leg Solana do commitment com mode='HTLC' — o vendedor
   *  tranca o token (ex.: wSOL) sob o MESMO sha256 do escrow V2 da outra rede. */
  private htlcLegOf(c: DealCommitment): DealCommitment['legs'][number] | null {
    return c.legs.find(l => l.escrowChain === 'solana' && l.mode === 'HTLC') ?? null;
  }

  /** Registro da perna HTLC: derivação determinística (sem tx) — o lock acontece no funding.
   *  SOL nativo (contractOrMint null) é suportado: htlc_lock_sol guarda lamports no próprio PDA. */
  private async registerHtlc(c: DealCommitment, leg: DealCommitment['legs'][number]): Promise<RegisterResult> {
    if (!c.htlcHash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'perna HTLC exige htlcHash (rota HTLC)');
    const funder = c.participants.find(p => p.role === leg.from)?.address;
    if (!funder || !this.validateAddress(funder)) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'vendedor sem endereço Solana válido');
    // Quem RECEBE no claim é a contraparte (comprador), que vive na rede do contrato — o endereço
    // Solana dele vem da carteira multichain da cadeira da mesa.
    const recipient = await this.deps.solAddressOf?.(c.dealId, leg.to as Role) ?? null;
    if (!recipient || !this.validateAddress(recipient)) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `${leg.to} sem endereço Solana na carteira multichain (necessário para receber o ativo do HTLC)`);
    const now = await this.inner.now();
    // Timeout LONGO (4 h ≫ 40 min do escrow V2): o vendedor tranca primeiro e nunca fica sem
    // janela de claim depois que a preimage é revelada na outra rede.
    const expiresAt = now + 4 * 3600;
    const htlcId = sha256Hex(`VERUM_HTLC_SOL|${c.dealHash}|${c.revision}`);
    // Nativo: o "vault" é o próprio PDA do HTLC (lamports); token: ATA do PDA.
    const mint = leg.asset.contractOrMint ?? null;
    const vault = mint
      ? associatedTokenAddress(this.inner.htlcPda(htlcId), new PublicKey(mint), await this.inner.tokenProgramFor(mint)).toBase58()
      : this.inner.htlcPda(htlcId).toBase58();
    const meta: HtlcMeta = { tradeId: htlcId, termsHash: c.htlcHash, onChainCreatedAt: now, onChainExpiresAt: expiresAt, htlcKind: 1, htlcHash: c.htlcHash, htlcMint: mint, htlcAmount: leg.amountBase, htlcFunder: funder, htlcRecipient: recipient, htlcVault: vault };
    return { ...this.ref('htlc-derived'), meta: meta as unknown as VerumMeta };
  }

  async registerDeal(c: DealCommitment): Promise<RegisterResult> {
    const htlcLeg = this.htlcLegOf(c);
    if (htlcLeg) return this.registerHtlc(c, htlcLeg).catch(e => { if (e instanceof DomainError) throw e; this.fail('register', e); });
    const existing = await bindingOf(this.deps, c.dealId, 'solana');
    if (existing) {
      const t = await this.inner.getTrade(existing.meta.tradeId).catch(() => null);
      if (t && t.state !== TradeState.NONE) return { ...this.ref('registered'), meta: existing.meta };
    }
    try {
      const now = await this.inner.now();
      const terms = buildVerumTerms(c, Number(this.cfg.chainId) as ChainId, this.cfg.programId, now, SOLANA_ABSENT_PM, EXTERNAL_ASSET);
      if (terms.sellerAmount > 0xffffffffffffffffn || terms.buyerAmount > 0xffffffffffffffffn) throw new DomainError('INVALID_INPUT', 'quantias excedem u64 (Solana)');
      const { tradeId, termsHash } = this.inner.computeIds(terms);
      await this.ensureAttested([terms.seller, terms.paymaster01, terms.paymaster02, terms.buyer].filter(w => w !== SOLANA_ABSENT_PM), terms.expiresAt + 3600);
      // Registrador: PM1 (dev keyring) ou o ATTESTOR quando o PM1 é carteira REAL — o backend não
      // tem a chave dele (mesma decisão da EVM: o registro não movimenta valor; termos conferidos
      // por todos via termsHash antes de assinar).
      const pm1Sk = this.signerFor(terms.paymaster01);
      const registrar = pm1Sk ? Keypair.fromSecretKey(pm1Sk) : this.attestor;
      await this.ensureLamports(registrar.publicKey);
      const unsigned = await this.inner.buildCreateTrade(terms, [
        { wallet: terms.seller, validUntil: terms.expiresAt + 3600, signature: '' }, { wallet: terms.paymaster01, validUntil: terms.expiresAt + 3600, signature: '' },
        { wallet: terms.paymaster02, validUntil: terms.expiresAt + 3600, signature: '' }, { wallet: terms.buyer, validUntil: terms.expiresAt + 3600, signature: '' },
      ], registrar.publicKey.toBase58());
      const tx = await this.submitUnsigned(unsigned, [registrar], registrar.publicKey);
      const meta: VerumMeta = { tradeId, termsHash, onChainCreatedAt: terms.createdAt, onChainExpiresAt: terms.expiresAt };
      return { ...this.ref(tx), meta };
    } catch (e) { this.fail('register', e); }
  }

  /** Funding da perna HTLC: detecta o lock on-chain; sem lock, assina com o keyring dev (quando
   *  disponível) ou devolve FUNDING_REQUIRED com a tx base64 p/ a Verum Wallet do vendedor. */
  private async depositHtlc(meta: HtlcMeta, from: string): Promise<TxRef> {
    const h = await this.inner.getHtlc(meta.tradeId);
    if (h) {
      if (h.state !== 'LOCKED') throw new DomainError('SETTLEMENT_NOT_ALLOWED', `HTLC em estado ${h.state}`);
      if (h.hash !== meta.htlcHash || h.amount < BigInt(meta.htlcAmount) || h.recipient !== meta.htlcRecipient) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'lock HTLC divergente dos termos (hash/quantia/destino)');
      return this.ref('htlc-locked');
    }
    const unsigned = await this.inner.buildHtlcLock({ htlcId: meta.tradeId, hash: meta.htlcHash, funder: meta.htlcFunder, recipient: meta.htlcRecipient, mint: meta.htlcMint, amount: BigInt(meta.htlcAmount), expiresAt: meta.onChainExpiresAt });
    const sk = this.signerFor(from);
    if (!sk) {
      const p = unsigned.payload as { transactionBase64: string };
      throw new DomainError('FUNDING_REQUIRED', meta.htlcMint ? 'Tranque o token no HTLC Solana pela sua carteira' : 'Tranque o SOL no HTLC pela sua carteira', { kind: 'solana-htlc', htlcId: meta.tradeId, vault: meta.htlcVault, requiredBase: meta.htlcAmount, transactionBase64: p.transactionBase64 });
    }
    const funder = Keypair.fromSecretKey(sk);
    await this.ensureLamports(funder.publicKey);
    const tx = await this.submitUnsigned(unsigned, [funder], funder.publicKey);
    return this.ref(tx);
  }

  /** Solana não tem approve: o depósito mesa é checagem de saldo (custódia real em seller_sign/buyer_sign). */
  async deposit(dealId: string, legIndex: number, from: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    if (isHtlcMeta(b.meta)) { try { return await this.depositHtlc(b.meta, from); } catch (e) { if (e instanceof DomainError) throw e; this.fail('deposit', e); } }
    try {
      const terms = await this.verumTermsOf(dealId, null, b.meta);
      const seller = legIndex === 0;
      const mint = seller ? terms.sellerAsset : terms.buyerAsset;
      // Perna EXTERNA cross-chain (BTC): não há depósito na Solana — custódia é o P2WSH na outra rede.
      if (mint === EXTERNAL_ASSET) return this.ref('external-leg-no-solana-deposit');
      const native = mint === SOLANA_ABSENT_PM; // perna NATIVA: saldo em lamports, sem ATA
      const need = seller ? terms.sellerAmount + computeFee(terms.sellerAmount, terms.platformFeeBps) : terms.buyerAmount + terms.commissionPm1 + terms.commissionPm2;
      const bal = await this.getBalance(from, { contractOrMint: native ? null : mint, network: 'solana' } as CanonicalAsset);
      if (bal < need) throw new DomainError('FUNDING_REQUIRED', `saldo insuficiente ${native ? 'em SOL' : 'na ATA'} (${bal} < ${need})`);
      return this.ref('balance-verified');
    } catch (e) { if (e instanceof DomainError) throw e; this.fail('deposit', e); }
  }

  /** A assinatura do papel é a PRÓPRIA transação (seller_sign deposita principal+fee; buyer_sign deposita e arma o settle). */
  async recordApproval(dealId: string, sig: ApprovalSignature): Promise<TxRef | null> {
    const b = await this.binding(dealId);
    // Perna HTLC: não há trade 4-assinaturas na Solana — a ordem/assinaturas vivem no escrow da
    // rede de contrato (signV2 na EVM); aqui o lock do vendedor é a "assinatura" (hashlock).
    if (isHtlcMeta(b.meta)) return null;
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

  async settle(dealId: string, _legIndex: number, _signatures: ApprovalSignature[], preimage?: string): Promise<TxRef> {
    const b = await this.binding(dealId);
    if (isHtlcMeta(b.meta)) {
      // Claim com a preimage REVELADA pelo settleV2 da rede de contrato — atômico pelo hashlock.
      const h = await this.inner.getHtlc(b.meta.tradeId);
      if (h?.state === 'CLAIMED') return this.ref('htlc-claimed');
      if (!preimage || !/^[0-9a-f]{2,128}$/i.test(preimage)) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'claim HTLC exige a preimage revelada pela perna de contrato');
      try {
        const unsigned = await this.inner.buildHtlcClaim(b.meta.tradeId, preimage.toLowerCase());
        const r = await this.inner.submitAsExecutor(unsigned);
        const conf = await this.inner.waitForConfirmation(r.txHash, 90_000);
        if (conf.status !== 'CONFIRMED') throw new Error(`htlc_claim não confirmado (${conf.status}): ${conf.reason ?? r.txHash}`);
        return this.ref(r.txHash);
      } catch (e) { this.fail('settle:htlc', e); }
    }
    const trade = await this.inner.getTrade(b.meta.tradeId);
    if (trade?.state === TradeState.SETTLED) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'trade já liquidada on-chain');
    try {
      // Cross-chain (htlcHash nos termos): settle_xchain EXIGE a preimage (revela on-chain e destrava
      // a perna BTC); mesa normal/nativa ignora o arg.
      const onchainTerms = await this.verumTermsOf(dealId, null, b.meta).catch(() => null);
      const needPreimage = !!onchainTerms?.htlcHash;
      if (needPreimage && (!preimage || !/^[0-9a-f]{2,128}$/i.test(preimage))) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'settle_xchain exige a preimage (sha256) do swap BTC↔Solana');
      const unsigned = await this.inner.buildSettle(b.meta.tradeId, needPreimage ? preimage!.toLowerCase() : undefined);
      const r = await this.inner.submitAsExecutor(unsigned);
      const conf = await this.inner.waitForConfirmation(r.txHash, 90_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`settle não confirmado (${conf.status}): ${conf.reason ?? r.txHash}`);
      return this.ref(r.txHash);
    } catch (e) { this.fail('settle', e); }
  }

  async refund(dealId: string, _legIndex: number): Promise<TxRef> {
    const b = await this.binding(dealId);
    if (isHtlcMeta(b.meta)) {
      const h = await this.inner.getHtlc(b.meta.tradeId);
      if (!h) return this.ref('htlc-never-locked');
      if (h.state === 'REFUNDED') return this.ref('refunded');
      if (h.state === 'CLAIMED') throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'HTLC já reivindicado (preimage revelada)');
      const now = await this.inner.now();
      if (now < h.expiresAt) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `refund do HTLC só após o timeout (${new Date(h.expiresAt * 1000).toISOString()}) — retryRefunds completa`);
      try {
        const r = await this.inner.submitAsExecutor(await this.inner.buildHtlcRefund(b.meta.tradeId));
        const conf = await this.inner.waitForConfirmation(r.txHash, 90_000);
        if (conf.status !== 'CONFIRMED') throw new Error(`htlc_refund não confirmado (${conf.status})`);
        return this.ref(r.txHash);
      } catch (e) { this.fail('refund:htlc', e); }
    }
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
    if (isHtlcMeta(bound.meta)) {
      const m = bound.meta;
      const h = await this.inner.getHtlc(m.tradeId).catch(() => null);
      const legIndex = 0; // perna do vendedor (assetIn) — único depósito nesta rede
      if (!h) return { status: 'REGISTERED', revision: bound.revision, deposits: {}, settledLegs: {}, dealHash: bound.dealHash || undefined, expiresAt: m.onChainExpiresAt, tradeId: m.tradeId };
      const status = h.state === 'CLAIMED' ? 'SETTLED' as const : h.state === 'REFUNDED' ? 'REFUNDED' as const : 'FUNDED' as const;
      return { status, revision: bound.revision, deposits: h.state === 'LOCKED' ? { [legIndex]: h.amount.toString() } : {}, settledLegs: h.state === 'CLAIMED' ? { [legIndex]: 'htlc-claimed' } : {}, dealHash: bound.dealHash || undefined, expiresAt: h.expiresAt, tradeId: m.tradeId };
    }
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
  /** Preimage revelada no claim do HTLC (lida do estado on-chain) — caminho inverso do fluxo normal. */
  async revealedPreimage(dealId: string): Promise<string | null> {
    const b = await bindingOf(this.deps, dealId, 'solana');
    if (!b || !isHtlcMeta(b.meta)) return null;
    const h = await this.inner.getHtlc(b.meta.tradeId).catch(() => null);
    return h?.revealedPreimage ?? null;
  }

  private async binding(dealId: string): Promise<{ meta: VerumMeta; dealHash: string }> {
    const b = await bindingOf(this.deps, dealId, 'solana');
    if (!b) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `deal ${dealId} sem registro on-chain (meta ausente)`);
    return b;
  }

  /* ---------- fluxo de carteira real (/v1/deals/:id/onchain-tx) ---------- */
  /** Desembrulho de wSOL → SOL nativo: fecha a conta de wSOL do dono (CloseAccount credita TODOS
   *  os lamports — valor embrulhado + rent — de volta à carteira). A tx é assinada pela própria
   *  carteira; null = nada a desembrulhar. O embrulho de ida já é automático no depósito. */
  async buildUnwrapWsol(owner: string): Promise<Record<string, unknown> | null> {
    if (!this.validateAddress(owner)) throw new DomainError('INVALID_INPUT', 'endereço Solana inválido');
    const ownerPk = new PublicKey(owner);
    const ata = associatedTokenAddress(ownerPk, new PublicKey(WSOL_MINT), TOKEN_PROGRAM_ID);
    const bal = await this.conn.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
    if (!bal || BigInt(bal.value.amount) === 0n) return null;
    // CloseAccount (ix 9 do Token Program): [conta wSOL, destino dos lamports, dono].
    const ix = new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: true, isWritable: false },
    ], data: Buffer.from([9]) });
    const tx = new Transaction().add(ix);
    tx.feePayer = ownerPk;
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    return { kind: 'solana', purpose: 'wsol_unwrap', amountBase: bal.value.amount, transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), recentBlockhash: blockhash, lastValidBlockHeight };
  }
  /** Broadcast da tx de desembrulho assinada pela carteira. */
  async submitUnwrapWsol(signedTransactionBase64: string): Promise<{ txHash: string }> {
    try {
      const sig = await this.conn.sendRawTransaction(Buffer.from(signedTransactionBase64, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed' });
      const conf = await this.inner.waitForConfirmation(sig, 90_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`unwrap não confirmado (${conf.status}): ${conf.reason ?? sig}`);
      return { txHash: sig };
    } catch (e) { this.fail('wsolUnwrap', e); }
  }

  /** Na Solana o papel assina a PRÓPRIA transação: devolve a tx base64 fresca para a Verum Wallet assinar. */
  async buildParticipantStep(dealId: string, role: Role, signer: string): Promise<Record<string, unknown>> {
    const b = await this.binding(dealId);
    if (isHtlcMeta(b.meta)) {
      // O único passo do participante nesta rede é o LOCK do vendedor; os demais assinam na rede
      // do contrato (signV2). Devolve a tx fresca de htlc_lock para a Verum Wallet.
      const m = b.meta;
      if (role !== 'SELLER' || signer !== m.htlcFunder) return { kind: 'done', tradeId: m.tradeId };
      const h = await this.inner.getHtlc(m.tradeId);
      if (h) return { kind: 'done', tradeId: m.tradeId, state: h.state };
      const unsigned = await this.inner.buildHtlcLock({ htlcId: m.tradeId, hash: m.htlcHash, funder: m.htlcFunder, recipient: m.htlcRecipient, mint: m.htlcMint, amount: BigInt(m.htlcAmount), expiresAt: m.onChainExpiresAt });
      const p = unsigned.payload as { transactionBase64: string; recentBlockhash: string; lastValidBlockHeight: number };
      return { kind: 'solana', purpose: 'htlc_lock', tradeId: m.tradeId, vault: m.htlcVault, transactionBase64: p.transactionBase64, recentBlockhash: p.recentBlockhash, lastValidBlockHeight: p.lastValidBlockHeight };
    }
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
  /** Recebe a transação assinada pela carteira e faz o broadcast + confirmação. Passos RELAYED
   *  (PMs: executor = feePayer) chegam só com a assinatura do papel — o executor co-assina aqui. */
  async submitParticipantStep(_dealId: string, _role: Role, _signer: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const b64 = String(body.signedTransactionBase64 ?? '');
    if (!b64) throw new DomainError('INVALID_INPUT', 'esperado { signedTransactionBase64 }');
    try {
      const tx = Transaction.from(Buffer.from(b64, 'base64'));
      const execKey = this.executor.publicKey;
      if (tx.signatures.some(s => s.publicKey.equals(execKey) && !s.signature)) tx.partialSign(this.executor);
      const raw = tx.serialize();
      const sig = await this.conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
      const conf = await this.inner.waitForConfirmation(sig, 90_000);
      if (conf.status !== 'CONFIRMED') throw new Error(`tx não confirmada (${conf.status}): ${conf.reason ?? sig}`);
      return { kind: 'broadcast', txHash: sig };
    } catch (e) { this.fail('participantStep', e); }
  }
}
