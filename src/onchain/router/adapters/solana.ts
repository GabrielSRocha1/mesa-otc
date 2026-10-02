// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/router/src/adapters/solana.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * SolanaChainAdapter — constrói instruções do programa `verum_otc` (Anchor 0.30.1) sem o client
 * Anchor em runtime: discriminadores = sha256("global:<ix>")[0..8], dados borsh codificados à mão
 * com o MESMO layout de `serializeTermsSolana` (packages/crypto) e `Terms::to_bytes` (Rust).
 *
 * Nunca assina como participante. As transações de participante voltam ao frontend (Verum Wallet)
 * como `UnsignedTx.payload.transactionBase64` para assinatura; o executor só assina transações
 * de settle/expire/refund (sem custódia — destinos são imutáveis nos termos).
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  type AccountMeta, type Commitment,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Role, TradeState, type ChainDescriptor, type Signature, type Terms, type TradeEvent, type WalletAttestation } from "../../types.js";
import { computeFee } from "../../core/index.js";
import { computeTradeIdSolana, hashTermsSolana, serializeTermsSolana, toHex, fromHex, base58Encode } from "../../crypto/index.js";
import type { ChainAdapter, Confirmation, OnChainTrade, PreflightReport, SubmitResult, UnsignedTx } from "../types.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const SEEDS = { config: "config", token: "token", trade: "trade", nonce: "nonce", attest: "attest" } as const;

/** Layout borsh do `Trade` (Rust): 8 disc | trade_id 32 | terms 244 | terms_hash 32 | state u8 | 3×bool | fee u64 | settled i64 | expired i64 | 2×pubkey | bump */
export const TERMS_LEN = 32 * 4 + 32 + 8 + 32 + 8 + 2 * 4 + 8 + 8 + 4 + 8; // 244
const TRADE_LAYOUT = { discriminator: 8, tradeId: 32, terms: TERMS_LEN, termsHash: 32 } as const;

export function anchorDiscriminator(kind: "global" | "account" | "event", name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${kind}:${name}`)).slice(0, 8);
}

export function findPda(programId: PublicKey, seeds: (Uint8Array | string)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : Buffer.from(s))), programId);
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

function i64le(n: number | bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; }
function u64le(n: bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function concat(...parts: Uint8Array[]): Buffer { return Buffer.concat(parts.map((p) => Buffer.from(p))); }
const pk = (s: string) => new PublicKey(s);

function meta(pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta { return { pubkey, isWritable, isSigner }; }

export interface SolanaAdapterOptions {
  rpcUrl?: string;
  connection?: Connection;
  /** Executor sem custódia (settle/expire/refund). Opcional (somente leitura). */
  executorKeypair?: Keypair;
  commitment?: Commitment;
  /** Lamports mínimos exigidos de cada participante para pagar suas próprias transações. */
  minLamports?: number;
  /** Mapa mint → token program, preenchido a partir do registry on-chain (lido sob demanda se ausente). */
  tokenPrograms?: Record<string, "TOKEN" | "TOKEN_2022">;
}

export class SolanaChainAdapter implements ChainAdapter {
  readonly programId: PublicKey;
  readonly configPda: PublicKey;
  private readonly conn: Connection;
  private readonly executor: Keypair | undefined;
  private readonly commitment: Commitment;
  private readonly minLamports: number;
  private readonly tokenPrograms = new Map<string, PublicKey>();

  constructor(readonly chain: ChainDescriptor, opts: SolanaAdapterOptions = {}) {
    if (chain.kind !== "SOLANA") throw new Error("SolanaChainAdapter requer ChainDescriptor.kind === SOLANA");
    this.programId = pk(chain.escrowAddress);
    this.configPda = findPda(this.programId, [SEEDS.config])[0];
    this.commitment = opts.commitment ?? "confirmed";
    this.conn = opts.connection ?? new Connection(opts.rpcUrl ?? chain.rpcUrl, this.commitment);
    this.executor = opts.executorKeypair;
    this.minLamports = opts.minLamports ?? 5_000_000; // 0,005 SOL
    for (const [mint, p] of Object.entries(opts.tokenPrograms ?? {})) this.tokenPrograms.set(mint, p === "TOKEN_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  }

  // ----------------------------------------------------------------- IDs / PDAs
  computeIds(t: Terms) {
    const th = hashTermsSolana(t);
    return { termsHash: toHex(th), tradeId: toHex(computeTradeIdSolana(this.programId.toBase58(), th)) };
  }
  tradePda(tradeIdHex: string): PublicKey { return findPda(this.programId, [SEEDS.trade, fromHex(tradeIdHex)])[0]; }
  tokenPda(mint: string): PublicKey { return findPda(this.programId, [SEEDS.token, pk(mint).toBytes()])[0]; }
  attestPda(wallet: string): PublicKey { return findPda(this.programId, [SEEDS.attest, pk(wallet).toBytes()])[0]; }
  noncePda(paymaster01: string, nonce: bigint): PublicKey { return findPda(this.programId, [SEEDS.nonce, pk(paymaster01).toBytes(), u64le(nonce)])[0]; }

  // ----------------------------------------------------------------- registry
  async tokenProgramFor(mint: string): Promise<PublicKey> {
    const cached = this.tokenPrograms.get(mint);
    if (cached) return cached;
    const info = await this.conn.getAccountInfo(this.tokenPda(mint), this.commitment);
    if (!info) throw new Error(`TokenNotAuthorized: mint ${mint} não está no registry on-chain`);
    // TokenEntry: 8 disc | mint 32 | token_program 32 | ...
    const program = new PublicKey(info.data.subarray(40, 72));
    const status = info.data[72 + 1]; // decimals u8 em 72, status u8 em 73
    if (status !== 1) throw new Error(`TokenNotAuthorized: mint ${mint} não está ACTIVE`);
    this.tokenPrograms.set(mint, program);
    return program;
  }

  async readConfig(): Promise<{ owner: string; guardian: string; attestor: string; treasury: string; platformFeeBps: number; paused: boolean; registryVersion: number }> {
    const info = await this.conn.getAccountInfo(this.configPda, this.commitment);
    if (!info) throw new Error("Config não inicializada");
    const d = info.data; let o = 8;
    const owner = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const guardian = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const attestor = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const treasury = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const platformFeeBps = d.readUInt16LE(o); o += 2;
    const paused = d[o] === 1; o += 1;
    const registryVersion = d.readUInt32LE(o);
    return { owner, guardian, attestor, treasury, platformFeeBps, paused, registryVersion };
  }

  // ----------------------------------------------------------------- preflight
  async preflight(t: Terms): Promise<PreflightReport> {
    const issues: PreflightReport["issues"] = [];
    const cfg = await this.readConfig();
    const now = await this.now();
    if (cfg.platformFeeBps !== t.platformFeeBps) issues.push({ code: "FEE_MISMATCH", message: `fee on-chain ${cfg.platformFeeBps} bps ≠ termos ${t.platformFeeBps}` });
    for (const [asset, role] of [[t.sellerAsset, Role.SELLER], [t.buyerAsset, Role.BUYER]] as const) {
      try { await this.tokenProgramFor(asset); } catch (e) { issues.push({ code: "TOKEN_NOT_AUTHORIZED", message: (e as Error).message, role }); }
    }
    const wallets: [string, Role][] = [[t.seller, Role.SELLER], [t.paymaster01, Role.PAYMASTER_01], [t.paymaster02, Role.PAYMASTER_02], [t.buyer, Role.BUYER]];
    for (const [w, role] of wallets) {
      const lamports = await this.conn.getBalance(pk(w), this.commitment);
      if (lamports < this.minLamports) issues.push({ code: "NO_GAS", message: `${w} possui ${lamports} lamports (< ${this.minLamports})`, role });
      const a = await this.conn.getAccountInfo(this.attestPda(w), this.commitment);
      if (!a) issues.push({ code: "NOT_VERUM_WALLET", message: `${w} não possui atestado Verum Wallet`, role });
      else {
        const validUntil = Number(a.data.readBigInt64LE(8 + 32)); const revoked = a.data[8 + 32 + 8] === 1;
        if (revoked || validUntil < now) issues.push({ code: "NOT_VERUM_WALLET", message: `atestado de ${w} revogado/expirado`, role });
      }
    }
    if (issues.every((i) => i.code !== "TOKEN_NOT_AUTHORIZED")) {
      const need = t.sellerAmount + computeFee(t.sellerAmount, t.platformFeeBps);
      const sb = await this.tokenBalance(t.seller, t.sellerAsset);
      if (sb < need) issues.push({ code: "SELLER_BALANCE", message: `seller precisa de ${need} (principal + fee), tem ${sb}`, role: Role.SELLER });
      const bb = await this.tokenBalance(t.buyer, t.buyerAsset);
      if (bb < t.buyerAmount) issues.push({ code: "BUYER_BALANCE", message: `buyer precisa de ${t.buyerAmount}, tem ${bb}`, role: Role.BUYER });
    }
    return { ok: issues.length === 0, issues, chainNow: now, paused: cfg.paused, onChainFeeBps: cfg.platformFeeBps };
  }

  private async tokenBalance(owner: string, mint: string): Promise<bigint> {
    const program = await this.tokenProgramFor(mint);
    const ata = associatedTokenAddress(pk(owner), pk(mint), program);
    try { return BigInt((await this.conn.getTokenAccountBalance(ata, this.commitment)).value.amount); } catch { return 0n; }
  }

  // ----------------------------------------------------------------- construção de instruções
  private ix(name: string, keys: AccountMeta[], data: Uint8Array): TransactionInstruction {
    return new TransactionInstruction({ programId: this.programId, keys, data: concat(anchorDiscriminator("global", name), data) });
  }

  private async toUnsigned(signer: string | "ANY", ix: TransactionInstruction, description: string, feePayer?: PublicKey): Promise<UnsignedTx> {
    const tx = new Transaction().add(ix);
    const payer = feePayer ?? (signer === "ANY" ? this.executor?.publicKey : pk(signer));
    if (payer) tx.feePayer = payer;
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash(this.commitment);
    tx.recentBlockhash = blockhash;
    return {
      chainId: this.chain.chainId, signer, description,
      payload: {
        programId: this.programId.toBase58(),
        instruction: ix.data.toString("base64"),
        accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
        transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        recentBlockhash: blockhash, lastValidBlockHeight,
      },
    };
  }

  /** Atestados na Solana são PDAs já existentes; o argumento é aceito por compatibilidade de interface e verificado no preflight. */
  async buildCreateTrade(terms: Terms, _attestations: [WalletAttestation, WalletAttestation, WalletAttestation, WalletAttestation]): Promise<UnsignedTx> {
    const { tradeId } = this.computeIds(terms);
    const keys: AccountMeta[] = [
      meta(this.configPda, false),
      meta(pk(terms.paymaster01), true, true),
      meta(this.tradePda(tradeId), true),
      meta(this.noncePda(terms.paymaster01, terms.nonce), true),
      meta(this.tokenPda(terms.sellerAsset), false),
      meta(this.tokenPda(terms.buyerAsset), false),
      meta(this.attestPda(terms.seller), false),
      meta(this.attestPda(terms.paymaster01), false),
      meta(this.attestPda(terms.paymaster02), false),
      meta(this.attestPda(terms.buyer), false),
      meta(SystemProgram.programId, false),
    ];
    const data = concat(fromHex(tradeId), serializeTermsSolana(terms));
    return this.toUnsigned(terms.paymaster01, this.ix("create_trade", keys, data), "create_trade (PAYMASTER_01)");
  }

  async buildSign(terms: Terms, tradeId: string, approval: Signature): Promise<UnsignedTx> {
    const trade = this.tradePda(tradeId);
    const data = concat(fromHex(approval.termsHash), i64le(approval.deadline));
    switch (approval.role) {
      case Role.SELLER: {
        const program = await this.tokenProgramFor(terms.sellerAsset);
        const cfg = await this.readConfig();
        const mint = pk(terms.sellerAsset); const seller = pk(terms.seller); const treasury = pk(cfg.treasury);
        const keys = [
          meta(this.configPda, false), meta(trade, true), meta(seller, true, true), meta(mint, false),
          meta(associatedTokenAddress(seller, mint, program), true),
          meta(associatedTokenAddress(trade, mint, program), true),
          meta(treasury, false), meta(associatedTokenAddress(treasury, mint, program), true),
          meta(program, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
        ];
        return this.toUnsigned(terms.seller, this.ix("seller_sign", keys, data), "seller_sign (deposita principal + paga fee)");
      }
      case Role.PAYMASTER_01:
      case Role.PAYMASTER_02: {
        const who = approval.role === Role.PAYMASTER_01 ? terms.paymaster01 : terms.paymaster02;
        const name = approval.role === Role.PAYMASTER_01 ? "paymaster01_sign" : "paymaster02_sign";
        const keys = [meta(this.configPda, false), meta(trade, true), meta(pk(who), false, true)];
        // Relayer pode pagar a taxa de rede (feePayer = executor), mas o paymaster continua obrigado a assinar.
        return this.toUnsigned(who, this.ix(name, keys, data), name, this.executor?.publicKey);
      }
      case Role.BUYER: {
        const program = await this.tokenProgramFor(terms.buyerAsset);
        const mint = pk(terms.buyerAsset); const buyer = pk(terms.buyer);
        const keys = [
          meta(this.configPda, false), meta(trade, true), meta(buyer, true, true), meta(mint, false),
          meta(associatedTokenAddress(buyer, mint, program), true),
          meta(associatedTokenAddress(trade, mint, program), true),
          meta(program, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
        ];
        return this.toUnsigned(terms.buyer, this.ix("buyer_sign", keys, data), "buyer_sign (deposita principal)");
      }
      default: throw new Error(`role inválida ${approval.role}`);
    }
  }

  private async loadTerms(tradeId: string): Promise<{ terms: Terms; sellerProgram: PublicKey; buyerProgram: PublicKey }> {
    const raw = await this.readTradeRaw(tradeId);
    if (!raw) throw new Error("TradeNotFound");
    return raw;
  }

  async buildSettle(tradeId: string): Promise<UnsignedTx> {
    const { terms, sellerProgram, buyerProgram } = await this.loadTerms(tradeId);
    const trade = this.tradePda(tradeId); const sm = pk(terms.sellerAsset); const bm = pk(terms.buyerAsset);
    const seller = pk(terms.seller); const buyer = pk(terms.buyer);
    const exec = this.executor?.publicKey ?? seller;
    const keys = [
      meta(this.configPda, false), meta(trade, true), meta(exec, true, true), meta(sm, false), meta(bm, false),
      meta(associatedTokenAddress(trade, sm, sellerProgram), true), meta(associatedTokenAddress(trade, bm, buyerProgram), true),
      meta(seller, true), meta(buyer, true),
      meta(associatedTokenAddress(buyer, sm, sellerProgram), true), meta(associatedTokenAddress(seller, bm, buyerProgram), true),
      meta(sellerProgram, false), meta(buyerProgram, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
    ];
    return this.toUnsigned("ANY", this.ix("settle", keys, new Uint8Array()), "settle");
  }

  async buildExpire(tradeId: string): Promise<UnsignedTx> {
    const trade = this.tradePda(tradeId);
    const exec = this.executor?.publicKey ?? pk((await this.loadTerms(tradeId)).terms.paymaster01);
    const keys = [meta(trade, true), meta(exec, false, true)];
    return this.toUnsigned("ANY", this.ix("expire_trade", keys, new Uint8Array()), "expire_trade");
  }

  async buildRefund(tradeId: string): Promise<UnsignedTx> {
    const { terms, sellerProgram, buyerProgram } = await this.loadTerms(tradeId);
    const trade = this.tradePda(tradeId); const sm = pk(terms.sellerAsset); const bm = pk(terms.buyerAsset);
    const seller = pk(terms.seller); const buyer = pk(terms.buyer);
    const exec = this.executor?.publicKey ?? seller;
    const keys = [
      meta(trade, true), meta(exec, false, true), meta(sm, false), meta(bm, false),
      meta(associatedTokenAddress(trade, sm, sellerProgram), true), meta(associatedTokenAddress(trade, bm, buyerProgram), true),
      meta(seller, true), meta(buyer, true),
      meta(associatedTokenAddress(seller, sm, sellerProgram), true), meta(associatedTokenAddress(buyer, bm, buyerProgram), true),
      meta(sellerProgram, false), meta(buyerProgram, false),
    ];
    return this.toUnsigned("ANY", this.ix("refund", keys, new Uint8Array()), "refund (devolve principais às origens)");
  }

  // ----------------------------------------------------------------- submissão / leitura
  async submitAsExecutor(tx: UnsignedTx): Promise<SubmitResult> {
    if (!this.executor) throw new Error("adapter Solana em modo somente leitura (sem executorKeypair)");
    if (tx.signer !== "ANY") throw new Error("executor não assina transações de participante");
    const t = Transaction.from(Buffer.from(tx.payload.transactionBase64 as string, "base64"));
    t.feePayer = this.executor.publicKey;
    t.sign(this.executor);
    const sig = await this.conn.sendRawTransaction(t.serialize(), { skipPreflight: false, preflightCommitment: this.commitment });
    return { txHash: sig };
  }

  private async readTradeRaw(tradeId: string): Promise<(OnChainTrade & { terms: Terms; sellerProgram: PublicKey; buyerProgram: PublicKey }) | null> {
    const info = await this.conn.getAccountInfo(this.tradePda(tradeId), this.commitment);
    if (!info) return null;
    const d = info.data; let o = TRADE_LAYOUT.discriminator;
    const onChainId = toHex(d.subarray(o, o + 32)); o += 32;
    const terms = decodeTerms(d.subarray(o, o + TERMS_LEN), this.chain, this.programId); o += TERMS_LEN;
    const termsHash = toHex(d.subarray(o, o + 32)); o += 32;
    const state = d[o] as TradeState; o += 1;
    const sellerDeposited = d[o] === 1; o += 1;
    const buyerDeposited = d[o] === 1; o += 1;
    const feeCollected = d[o] === 1; o += 1;
    const feeAmount = d.readBigUInt64LE(o); o += 8;
    const settledAt = Number(d.readBigInt64LE(o)); o += 8;
    const expiredAt = Number(d.readBigInt64LE(o)); o += 8;
    const sellerProgram = new PublicKey(d.subarray(o, o + 32)); o += 32;
    const buyerProgram = new PublicKey(d.subarray(o, o + 32));
    return { tradeId: onChainId, state, termsHash, sellerDeposited, buyerDeposited, feeCollected, feeAmount, expiresAt: terms.expiresAt, settledAt, expiredAt, terms, sellerProgram, buyerProgram };
  }

  async getTrade(tradeId: string): Promise<OnChainTrade | null> {
    const raw = await this.readTradeRaw(tradeId);
    if (!raw) return null;
    const { terms: _t, sellerProgram: _s, buyerProgram: _b, ...rest } = raw;
    return rest;
  }

  async waitForConfirmation(txHash: string, timeoutMs = 90_000): Promise<Confirmation> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const st = (await this.conn.getSignatureStatuses([txHash], { searchTransactionHistory: true })).value[0];
      if (st) {
        const level = st.confirmationStatus;
        if (st.err) return { txHash, status: "FAILED", confirmations: st.confirmations ?? 0, reason: JSON.stringify(st.err) };
        const ok = level === "finalized" || (level === "confirmed" && this.chain.requiredConfirmations <= 1);
        if (ok) return { txHash, status: "CONFIRMED", confirmations: st.confirmations ?? 32, blockNumber: st.slot };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { txHash, status: "TIMEOUT", confirmations: 0 };
  }

  async fetchEvents(tradeId: string): Promise<TradeEvent[]> {
    const sigs = await this.conn.getSignaturesForAddress(this.tradePda(tradeId), { limit: 200 }, this.commitment === "finalized" ? "finalized" : "confirmed");
    const out: TradeEvent[] = [];
    for (const s of sigs.reverse()) {
      const tx = await this.conn.getTransaction(s.signature, { commitment: this.commitment === "finalized" ? "finalized" : "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = tx?.meta?.logMessages ?? [];
      let idx = 0;
      for (const line of logs) {
        if (!line.startsWith("Program data: ")) continue;
        const buf = Buffer.from(line.slice("Program data: ".length), "base64");
        const ev = decodeEvent(buf);
        if (!ev) continue;
        if (ev.tradeId && ev.tradeId !== tradeId) continue;
        out.push({ name: ev.name, chainId: this.chain.chainId, tradeId, txHash: s.signature, blockNumber: s.slot, logIndex: idx++, timestamp: s.blockTime ?? 0, data: ev.data });
      }
    }
    return out;
  }

  async now(): Promise<number> {
    const slot = await this.conn.getSlot(this.commitment);
    const t = await this.conn.getBlockTime(slot);
    return t ?? Math.floor(Date.now() / 1000);
  }
}

// --------------------------------------------------------------------------- decoders
export function decodeTerms(b: Uint8Array, chain: ChainDescriptor, programId: PublicKey): Terms {
  const d = Buffer.from(b); let o = 0;
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32; return k; };
  const seller = key(), buyer = key(), paymaster01 = key(), paymaster02 = key();
  const sellerAsset = key(); const sellerAmount = d.readBigUInt64LE(o); o += 8;
  const buyerAsset = key(); const buyerAmount = d.readBigUInt64LE(o); o += 8;
  const platformFeeBps = d.readUInt16LE(o); o += 2; const commissionBps = d.readUInt16LE(o); o += 2;
  const discountBps = d.readUInt16LE(o); o += 2; const slippageBps = d.readUInt16LE(o); o += 2;
  const createdAt = Number(d.readBigInt64LE(o)); o += 8; const expiresAt = Number(d.readBigInt64LE(o)); o += 8;
  const termsVersion = d.readUInt32LE(o); o += 4; const nonce = d.readBigUInt64LE(o);
  return { chainId: chain.chainId, escrowAddress: programId.toBase58(), seller, buyer, paymaster01, paymaster02, sellerAsset, sellerAmount, buyerAsset, buyerAmount, platformFeeBps, commissionBps, discountBps, slippageBps, createdAt, expiresAt, termsVersion, nonce };
}

type EventSpec = { name: TradeEvent["name"]; fields: [string, "pubkey" | "u64" | "i64" | "u16" | "u32" | "u8" | "bytes32" | "string"][] };
const EVENTS: EventSpec[] = [
  { name: "TradeCreated", fields: [["tradeId", "bytes32"], ["termsHash", "bytes32"], ["seller", "pubkey"], ["buyer", "pubkey"], ["paymaster01", "pubkey"], ["paymaster02", "pubkey"], ["sellerAsset", "pubkey"], ["sellerAmount", "u64"], ["buyerAsset", "pubkey"], ["buyerAmount", "u64"], ["platformFeeBps", "u16"], ["feeAmount", "u64"], ["createdAt", "i64"], ["expiresAt", "i64"], ["nonce", "u64"]] },
  { name: "ParticipantAuthorized", fields: [["tradeId", "bytes32"], ["wallet", "pubkey"], ["role", "u8"]] },
  { name: "SellerSigned", fields: [["tradeId", "bytes32"], ["seller", "pubkey"]] },
  { name: "Paymaster01Signed", fields: [["tradeId", "bytes32"], ["paymaster", "pubkey"]] },
  { name: "Paymaster02Signed", fields: [["tradeId", "bytes32"], ["paymaster", "pubkey"]] },
  { name: "BuyerSigned", fields: [["tradeId", "bytes32"], ["buyer", "pubkey"]] },
  { name: "DepositReceived", fields: [["tradeId", "bytes32"], ["from", "pubkey"], ["mint", "pubkey"], ["amount", "u64"], ["role", "u8"]] },
  { name: "FeeCollected", fields: [["tradeId", "bytes32"], ["mint", "pubkey"], ["amount", "u64"], ["treasury", "pubkey"]] },
  { name: "SettlementReady", fields: [["tradeId", "bytes32"]] },
  { name: "TradeSettled", fields: [["tradeId", "bytes32"], ["settledAt", "i64"]] },
  { name: "TradeExpired", fields: [["tradeId", "bytes32"], ["expiredAt", "i64"], ["executor", "pubkey"]] },
  { name: "RefundExecuted", fields: [["tradeId", "bytes32"], ["to", "pubkey"], ["mint", "pubkey"], ["amount", "u64"]] },
  { name: "TokenAdded", fields: [["mint", "pubkey"], ["tokenProgram", "pubkey"], ["decimals", "u8"], ["symbol", "string"], ["registryVersion", "u32"]] },
  { name: "TokenSuspended", fields: [["mint", "pubkey"], ["registryVersion", "u32"]] },
  { name: "TokenRemoved", fields: [["mint", "pubkey"], ["registryVersion", "u32"]] },
  { name: "EmergencyPaused", fields: [["by", "pubkey"]] },
  { name: "EmergencyUnpaused", fields: [["by", "pubkey"]] },
  { name: "ConfigurationChanged", fields: [["feeBps", "u16"], ["treasury", "pubkey"], ["attestor", "pubkey"]] },
];
const EVENT_BY_DISC = new Map(EVENTS.map((e) => [Buffer.from(anchorDiscriminator("event", e.name)).toString("hex"), e]));

export function decodeEvent(buf: Buffer): { name: TradeEvent["name"]; tradeId: string | undefined; data: TradeEvent["data"] } | null {
  if (buf.length < 8) return null;
  const spec = EVENT_BY_DISC.get(buf.subarray(0, 8).toString("hex"));
  if (!spec) return null;
  const data: TradeEvent["data"] = {}; let o = 8; let tradeId: string | undefined;
  for (const [field, kind] of spec.fields) {
    switch (kind) {
      case "pubkey": data[field] = base58Encode(buf.subarray(o, o + 32)); o += 32; break;
      case "bytes32": { const h = toHex(buf.subarray(o, o + 32)); o += 32; data[field] = h; if (field === "tradeId") tradeId = h; break; }
      case "u64": data[field] = buf.readBigUInt64LE(o); o += 8; break;
      case "i64": data[field] = Number(buf.readBigInt64LE(o)); o += 8; break;
      case "u32": data[field] = buf.readUInt32LE(o); o += 4; break;
      case "u16": data[field] = buf.readUInt16LE(o); o += 2; break;
      case "u8": data[field] = buf[o] ?? 0; o += 1; break;
      case "string": { const len = buf.readUInt32LE(o); o += 4; data[field] = buf.subarray(o, o + len).toString("utf8"); o += len; break; }
    }
  }
  return { name: spec.name, tradeId, data };
}
