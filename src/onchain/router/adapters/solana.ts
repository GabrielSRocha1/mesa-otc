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
/** Mint nativo (wSOL) — igual em todos os clusters; habilita o embrulho automático no htlc_lock. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Cadeira AUSENTE nos Terms (Pubkey::default) — mesas de 2–3 participantes (ADR-v4). */
export const ABSENT_WALLET = "11111111111111111111111111111111";
/** Sentinela de PERNA EXTERNA (ativo fora da Solana, ex.: BTC): 32 bytes 0xFF (base58). Distinta da
 *  nativa (ABSENT_WALLET/0x00) — marca o lado cross-chain que NÃO deposita nem é pago na Solana. */
export const EXTERNAL_ASSET = new PublicKey(new Uint8Array(32).fill(0xff)).toBase58();

const SEEDS = { config: "config", token: "token", trade: "trade", nonce: "nonce", attest: "attest", htlc: "htlc" } as const;

/** Layout borsh do `Trade` (Rust): 8 disc | trade_id 32 | terms 292 | terms_hash 32 | state u8 | 3×bool | fee u64 | settled i64 | expired i64 | 2×pubkey | bump */
export const TERMS_LEN = 32 * 4 + 32 + 8 + 32 + 8 + 2 * 4 + 8 + 8 + 4 + 8 + 8 + 8 + 32; // 292 (termos v3: +htlcHash)
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
    for (const [asset, role] of ([[t.sellerAsset, Role.SELLER], [t.buyerAsset, Role.BUYER]] as const).filter(([a]) => a !== ABSENT_WALLET)) {
      try { await this.tokenProgramFor(asset); } catch (e) { issues.push({ code: "TOKEN_NOT_AUTHORIZED", message: (e as Error).message, role }); }
    }
    const wallets: [string, Role][] = ([[t.seller, Role.SELLER], [t.paymaster01, Role.PAYMASTER_01], [t.paymaster02, Role.PAYMASTER_02], [t.buyer, Role.BUYER]] as [string, Role][])
      .filter(([w]) => w !== ABSENT_WALLET); // cadeira ausente (2–3 participantes) não tem gás/atestado
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
      const buyerTotal = t.buyerAmount + t.commissionPm1 + t.commissionPm2; // principal + comissões on-chain
      if (bb < buyerTotal) issues.push({ code: "BUYER_BALANCE", message: `buyer precisa de ${buyerTotal} (principal + comissões), tem ${bb}`, role: Role.BUYER });
    }
    return { ok: issues.length === 0, issues, chainNow: now, paused: cfg.paused, onChainFeeBps: cfg.platformFeeBps };
  }

  private async tokenBalance(owner: string, mint: string): Promise<bigint> {
    if (mint === ABSENT_WALLET) return BigInt(await this.conn.getBalance(pk(owner), this.commitment)); // perna NATIVA
    const program = await this.tokenProgramFor(mint);
    const ata = associatedTokenAddress(pk(owner), pk(mint), program);
    let bal = 0n;
    try { bal = BigInt((await this.conn.getTokenAccountBalance(ata, this.commitment)).value.amount); } catch { /* ATA inexistente */ }
    // wSOL: SOL nativo também conta (a tx de depósito embrulha o que faltar) — reserva p/ gás.
    if (mint === WSOL_MINT) {
      const lamports = BigInt(await this.conn.getBalance(pk(owner), this.commitment));
      const reserve = 10_000_000n; // 0.01 SOL
      bal += lamports > reserve ? lamports - reserve : 0n;
    }
    return bal;
  }

  // ----------------------------------------------------------------- construção de instruções
  private ix(name: string, keys: AccountMeta[], data: Uint8Array): TransactionInstruction {
    return new TransactionInstruction({ programId: this.programId, keys, data: concat(anchorDiscriminator("global", name), data) });
  }

  private async toUnsigned(signer: string | "ANY", ixOrIxs: TransactionInstruction | TransactionInstruction[], description: string, feePayer?: PublicKey): Promise<UnsignedTx> {
    const ixs = Array.isArray(ixOrIxs) ? ixOrIxs : [ixOrIxs];
    const ix = ixs[ixs.length - 1] as TransactionInstruction; // a do programa (payload expõe só ela)
    const tx = new Transaction().add(...ixs);
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

  /** Atestados na Solana são PDAs já existentes; o argumento é aceito por compatibilidade de interface e verificado no preflight.
   *  `registrar` (opcional) = quem assina/paga o create_trade — PM1 (padrão) ou o ATTESTOR da
   *  Config (carteiras reais: o backend não tem a chave do PM1; espelha a EVM). */
  async buildCreateTrade(terms: Terms, _attestations: [WalletAttestation, WalletAttestation, WalletAttestation, WalletAttestation], registrar?: string): Promise<UnsignedTx> {
    const { tradeId } = this.computeIds(terms);
    const signer = registrar ?? terms.paymaster01;
    const keys: AccountMeta[] = [
      meta(this.configPda, false),
      meta(pk(signer), true, true),
      meta(this.tradePda(tradeId), true),
      meta(this.noncePda(terms.paymaster01, terms.nonce), true),
      // Perna AUSENTE/NATIVA (ABSENT_WALLET) ou EXTERNA (EXTERNAL_ASSET) não tem registry → Option=None.
      meta(terms.sellerAsset === ABSENT_WALLET || terms.sellerAsset === EXTERNAL_ASSET ? this.programId : this.tokenPda(terms.sellerAsset), false),
      meta(terms.buyerAsset === ABSENT_WALLET || terms.buyerAsset === EXTERNAL_ASSET ? this.programId : this.tokenPda(terms.buyerAsset), false),
      meta(this.attestPda(terms.seller), false),
      // Pay Master ausente (Pubkey::default) → conta Option=None do Anchor = o PRÓPRIO programa.
      meta(terms.paymaster01 === ABSENT_WALLET ? this.programId : this.attestPda(terms.paymaster01), false),
      meta(terms.paymaster02 === ABSENT_WALLET ? this.programId : this.attestPda(terms.paymaster02), false),
      meta(this.attestPda(terms.buyer), false),
      meta(SystemProgram.programId, false),
    ];
    const data = concat(fromHex(tradeId), serializeTermsSolana(terms));
    return this.toUnsigned(signer, this.ix("create_trade", keys, data), `create_trade (${registrar && registrar !== terms.paymaster01 ? 'ATTESTOR registrar' : 'PAYMASTER_01'})`);
  }

  async buildSign(terms: Terms, tradeId: string, approval: Signature): Promise<UnsignedTx> {
    const trade = this.tradePda(tradeId);
    const data = concat(fromHex(approval.termsHash), i64le(approval.deadline));
    // Perna EXTERNA (cross-chain, ex.: BTC): o lado externo apenas ASSINA — sem depósito na Solana.
    if (approval.role === Role.SELLER && terms.sellerAsset === EXTERNAL_ASSET) {
      const keys = [meta(this.configPda, false), meta(trade, true), meta(pk(terms.seller), true, true)];
      return this.toUnsigned(terms.seller, this.ix("seller_sign_external", keys, data), "seller_sign_external (vendedor externo: assina sem depositar)");
    }
    if (approval.role === Role.BUYER && terms.buyerAsset === EXTERNAL_ASSET) {
      const keys = [meta(this.configPda, false), meta(trade, true), meta(pk(terms.buyer), true, true)];
      return this.toUnsigned(terms.buyer, this.ix("buyer_sign_external", keys, data), "buyer_sign_external (comprador externo: assina sem depositar)");
    }
    // Perna NATIVA (asset = Pubkey::default): depósito em lamports no PDA — SOL entra solto.
    if (approval.role === Role.SELLER && terms.sellerAsset === ABSENT_WALLET) {
      const cfg = await this.readConfig();
      const keys = [meta(this.configPda, false), meta(trade, true), meta(pk(terms.seller), true, true), meta(pk(cfg.treasury), true), meta(SystemProgram.programId, false)];
      return this.toUnsigned(terms.seller, this.ix("seller_sign_sol", keys, data), "seller_sign_sol (deposita SOL nativo + fee)");
    }
    if (approval.role === Role.BUYER && terms.buyerAsset === ABSENT_WALLET) {
      const keys = [meta(this.configPda, false), meta(trade, true), meta(pk(terms.buyer), true, true), meta(SystemProgram.programId, false)];
      return this.toUnsigned(terms.buyer, this.ix("buyer_sign_sol", keys, data), "buyer_sign_sol (paga em SOL nativo + comissões)");
    }
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
        // Vendedor de "SOL": embrulha na própria tx o principal + fee que faltam na ATA de wSOL.
        const sellerWrap = terms.sellerAsset === WSOL_MINT ? await this.wrapSolIxs(seller, terms.sellerAmount + computeFee(terms.sellerAmount, terms.platformFeeBps)) : [];
        return this.toUnsigned(terms.seller, [...sellerWrap, this.ix("seller_sign", keys, data)], "seller_sign (deposita principal + paga fee)");
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
        const buyerWrap = terms.buyerAsset === WSOL_MINT ? await this.wrapSolIxs(buyer, terms.buyerAmount + terms.commissionPm1 + terms.commissionPm2) : [];
        return this.toUnsigned(terms.buyer, [...buyerWrap, this.ix("buyer_sign", keys, data)], "buyer_sign (deposita principal)");
      }
      default: throw new Error(`role inválida ${approval.role}`);
    }
  }

  private async loadTerms(tradeId: string): Promise<{ terms: Terms; sellerProgram: PublicKey; buyerProgram: PublicKey }> {
    const raw = await this.readTradeRaw(tradeId);
    if (!raw) throw new Error("TradeNotFound");
    return raw;
  }

  async buildSettle(tradeId: string, preimageHex?: string): Promise<UnsignedTx> {
    const { terms, sellerProgram, buyerProgram } = await this.loadTerms(tradeId);
    const trade = this.tradePda(tradeId);
    const seller = pk(terms.seller); const buyer = pk(terms.buyer);
    const exec = this.executor?.publicKey ?? seller;
    // Perna CROSS-CHAIN (htlcHash): UMA perna de token SPL + perna externa (BTC) via preimage.
    if (terms.htlcHash) {
      if (!preimageHex) throw new Error("settle_xchain exige a preimage do hashlock");
      const sellerExt = terms.sellerAsset === EXTERNAL_ASSET;
      const onchainAsset = sellerExt ? terms.buyerAsset : terms.sellerAsset;
      const onchainProgram = sellerExt ? buyerProgram : sellerProgram;
      const recipientW = sellerExt ? seller : buyer; // quem recebe o token on-chain
      const depositorW = sellerExt ? buyer : seller; // quem depositou (recebe o rent no close)
      const om = pk(onchainAsset);
      // Comissões só existem quando o COMPRADOR paga on-chain (vendedor externo); senão None.
      const pm1On = sellerExt && terms.commissionPm1 > 0n && terms.paymaster01 !== ABSENT_WALLET;
      const pm2On = sellerExt && terms.commissionPm2 > 0n && terms.paymaster02 !== ABSENT_WALLET;
      const keys = [
        meta(this.configPda, false), meta(trade, true), meta(exec, true, true), meta(om, false),
        meta(associatedTokenAddress(trade, om, onchainProgram), true),
        meta(recipientW, true), meta(associatedTokenAddress(recipientW, om, onchainProgram), true),
        meta(depositorW, true),
        meta(pm1On ? pk(terms.paymaster01) : this.programId, pm1On), meta(pm1On ? associatedTokenAddress(pk(terms.paymaster01), om, onchainProgram) : this.programId, pm1On),
        meta(pm2On ? pk(terms.paymaster02) : this.programId, pm2On), meta(pm2On ? associatedTokenAddress(pk(terms.paymaster02), om, onchainProgram) : this.programId, pm2On),
        meta(onchainProgram, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
      ];
      const preimage = fromHex(preimageHex);
      const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, preimage.length, true);
      return this.toUnsigned("ANY", this.ix("settle_xchain", keys, concat(len, preimage)), "settle_xchain (revela preimage; token → destino fixo)");
    }
    // Perna NATIVA de um dos lados → settle dedicado (lamports direto do PDA, sem wSOL).
    const pm1C = terms.commissionPm1 > 0n && terms.paymaster01 !== ABSENT_WALLET;
    const pm2C = terms.commissionPm2 > 0n && terms.paymaster02 !== ABSENT_WALLET;
    if (terms.sellerAsset === ABSENT_WALLET) {
      const bm0 = pk(terms.buyerAsset);
      const keys0 = [
        meta(this.configPda, false), meta(trade, true), meta(exec, true, true), meta(bm0, false),
        meta(associatedTokenAddress(trade, bm0, buyerProgram), true),
        meta(seller, true), meta(buyer, true),
        meta(associatedTokenAddress(seller, bm0, buyerProgram), true),
        meta(pm1C ? pk(terms.paymaster01) : this.programId, pm1C), meta(pm1C ? associatedTokenAddress(pk(terms.paymaster01), bm0, buyerProgram) : this.programId, pm1C),
        meta(pm2C ? pk(terms.paymaster02) : this.programId, pm2C), meta(pm2C ? associatedTokenAddress(pk(terms.paymaster02), bm0, buyerProgram) : this.programId, pm2C),
        meta(buyerProgram, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
      ];
      return this.toUnsigned("ANY", this.ix("settle_native_seller", keys0, new Uint8Array()), "settle_native_seller (SOL → comprador; token → vendedor)");
    }
    if (terms.buyerAsset === ABSENT_WALLET) {
      const sm0 = pk(terms.sellerAsset);
      const keys0 = [
        meta(this.configPda, false), meta(trade, true), meta(exec, true, true), meta(sm0, false),
        meta(associatedTokenAddress(trade, sm0, sellerProgram), true),
        meta(seller, true), meta(buyer, true),
        meta(associatedTokenAddress(buyer, sm0, sellerProgram), true),
        meta(pm1C ? pk(terms.paymaster01) : this.programId, pm1C),
        meta(pm2C ? pk(terms.paymaster02) : this.programId, pm2C),
        meta(sellerProgram, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
      ];
      return this.toUnsigned("ANY", this.ix("settle_native_buyer", keys0, new Uint8Array()), "settle_native_buyer (token → comprador; SOL → vendedor/PMs)");
    }
    const sm = pk(terms.sellerAsset); const bm = pk(terms.buyerAsset);
    // Comissões on-chain (termos v2): contas dos PMs e suas ATAs do buyerAsset; comissão zero ou
    // cadeira ausente → Option=None do Anchor (o PRÓPRIO programa no slot).
    const pm1On = terms.commissionPm1 > 0n && terms.paymaster01 !== ABSENT_WALLET;
    const pm2On = terms.commissionPm2 > 0n && terms.paymaster02 !== ABSENT_WALLET;
    const keys = [
      meta(this.configPda, false), meta(trade, true), meta(exec, true, true), meta(sm, false), meta(bm, false),
      meta(associatedTokenAddress(trade, sm, sellerProgram), true), meta(associatedTokenAddress(trade, bm, buyerProgram), true),
      meta(seller, true), meta(buyer, true),
      meta(associatedTokenAddress(buyer, sm, sellerProgram), true), meta(associatedTokenAddress(seller, bm, buyerProgram), true),
      meta(pm1On ? pk(terms.paymaster01) : this.programId, pm1On), meta(pm1On ? associatedTokenAddress(pk(terms.paymaster01), bm, buyerProgram) : this.programId, pm1On),
      meta(pm2On ? pk(terms.paymaster02) : this.programId, pm2On), meta(pm2On ? associatedTokenAddress(pk(terms.paymaster02), bm, buyerProgram) : this.programId, pm2On),
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
    const trade = this.tradePda(tradeId);
    const seller = pk(terms.seller); const buyer = pk(terms.buyer);
    const exec = this.executor?.publicKey ?? seller;
    // Perna CROSS-CHAIN (htlcHash): devolve SOMENTE a única perna de token on-chain ao depositante
    // (a perna externa/BTC volta pelo timeout do P2WSH, fora da Solana).
    if (terms.htlcHash) {
      const sellerExt = terms.sellerAsset === EXTERNAL_ASSET;
      const onchainAsset = sellerExt ? terms.buyerAsset : terms.sellerAsset;
      const onchainProgram = sellerExt ? buyerProgram : sellerProgram;
      const depositorW = sellerExt ? buyer : seller;
      const om = pk(onchainAsset);
      const keys = [
        meta(trade, true), meta(exec, true, true), meta(om, false),
        meta(associatedTokenAddress(trade, om, onchainProgram), true),
        meta(depositorW, true), meta(associatedTokenAddress(depositorW, om, onchainProgram), true),
        meta(onchainProgram, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
      ];
      return this.toUnsigned("ANY", this.ix("refund_xchain", keys, new Uint8Array()), "refund_xchain (devolve a perna de token ao depositante)");
    }
    // Mesa com perna NATIVA → refund dedicado (lamports do PDA + perna de token).
    if (terms.sellerAsset === ABSENT_WALLET || terms.buyerAsset === ABSENT_WALLET) {
      const nativeSeller = terms.sellerAsset === ABSENT_WALLET;
      const tokenMint = pk(nativeSeller ? terms.buyerAsset : terms.sellerAsset);
      const tokenProgram = nativeSeller ? buyerProgram : sellerProgram;
      const depositor = nativeSeller ? buyer : seller;
      const keys0 = [
        meta(trade, true), meta(exec, true, true), meta(tokenMint, false),
        meta(associatedTokenAddress(trade, tokenMint, tokenProgram), true),
        meta(seller, true), meta(buyer, true),
        meta(associatedTokenAddress(depositor, tokenMint, tokenProgram), true),
        meta(tokenProgram, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
      ];
      return this.toUnsigned("ANY", this.ix("refund_native", keys0, new Uint8Array()), "refund_native (devolve SOL + token às origens)");
    }
    const sm = pk(terms.sellerAsset); const bm = pk(terms.buyerAsset);
    const keys = [
      meta(trade, true), meta(exec, false, true), meta(sm, false), meta(bm, false),
      meta(associatedTokenAddress(trade, sm, sellerProgram), true), meta(associatedTokenAddress(trade, bm, buyerProgram), true),
      meta(seller, true), meta(buyer, true),
      meta(associatedTokenAddress(seller, sm, sellerProgram), true), meta(associatedTokenAddress(buyer, bm, buyerProgram), true),
      meta(sellerProgram, false), meta(buyerProgram, false),
    ];
    return this.toUnsigned("ANY", this.ix("refund", keys, new Uint8Array()), "refund (devolve principais às origens)");
  }

  // ----------------------------------------------------------------- perna HTLC cross-chain (ADR-v5)
  htlcPda(htlcIdHex: string): PublicKey { return findPda(this.programId, [SEEDS.htlc, fromHex(htlcIdHex)])[0]; }

  /** Embrulho SOL→wSOL dentro da PRÓPRIA tx (mint nativo): cria a ATA (idempotente), transfere os
   *  lamports que faltam e dá SyncNative — o vendedor escolhe "wSOL" tendo só SOL e o lock funciona. */
  private async wrapSolIxs(funder: PublicKey, amount: bigint): Promise<TransactionInstruction[]> {
    const mint = pk(WSOL_MINT);
    const ata = associatedTokenAddress(funder, mint, TOKEN_PROGRAM_ID);
    let have = 0n;
    try { have = BigInt((await this.conn.getTokenAccountBalance(ata, this.commitment)).value.amount); } catch { /* ATA inexistente */ }
    if (have >= amount) return [];
    const createAta = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [meta(funder, true, true), meta(ata, true), meta(funder, false), meta(mint, false), meta(SystemProgram.programId, false), meta(TOKEN_PROGRAM_ID, false)],
      data: Buffer.from([1]), // CreateIdempotent
    });
    const syncNative = new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [meta(ata, true)], data: Buffer.from([17]) });
    return [createAta, SystemProgram.transfer({ fromPubkey: funder, toPubkey: ata, lamports: amount - have }), syncNative];
  }

  /** Tranca `amount` sob hashlock sha256 — assinada pelo funder (vendedor) na Verum Wallet.
   *  mint=null → SOL NATIVO (htlc_lock_sol: lamports guardados no próprio PDA, sem wSOL).
   *  Contas na ORDEM EXATA do Rust; dados borsh: htlc_id | hash | recipient | amount | expires_at. */
  async buildHtlcLock(p: { htlcId: string; hash: string; funder: string; recipient: string; mint: string | null; amount: bigint; expiresAt: number }): Promise<UnsignedTx> {
    const funder = pk(p.funder);
    const htlc = this.htlcPda(p.htlcId);
    const data = concat(fromHex(p.htlcId), fromHex(p.hash), pk(p.recipient).toBytes(), u64le(p.amount), i64le(p.expiresAt));
    if (p.mint == null) {
      const keys = [meta(this.configPda, false), meta(funder, true, true), meta(htlc, true), meta(SystemProgram.programId, false)];
      return this.toUnsigned(p.funder, this.ix("htlc_lock_sol", keys, data), "htlc_lock_sol (tranca SOL nativo sob hashlock)");
    }
    const program = await this.tokenProgramFor(p.mint);
    const mint = pk(p.mint);
    const keys = [
      meta(this.configPda, false), meta(funder, true, true), meta(htlc, true),
      meta(this.tokenPda(p.mint), false), meta(mint, false),
      meta(associatedTokenAddress(funder, mint, program), true),
      meta(associatedTokenAddress(htlc, mint, program), true),
      meta(program, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
    ];
    const wrap = p.mint === WSOL_MINT ? await this.wrapSolIxs(funder, p.amount) : [];
    return this.toUnsigned(p.funder, [...wrap, this.ix("htlc_lock", keys, data)], "htlc_lock (tranca o token sob hashlock)");
  }

  /** Claim com a preimage revelada na outra rede — qualquer executor; destino fixo (recipient). */
  async buildHtlcClaim(htlcIdHex: string, preimageHex: string): Promise<UnsignedTx> {
    const h = await this.getHtlc(htlcIdHex);
    if (!h) throw new Error("HtlcNotFound");
    const htlcAcc = this.htlcPda(htlcIdHex);
    if (h.native) {
      const exec0 = this.executor?.publicKey ?? pk(h.recipient);
      const keys0 = [meta(htlcAcc, true), meta(exec0, false, true), meta(pk(h.recipient), true)];
      const preimage0 = fromHex(preimageHex);
      const len0 = new Uint8Array(4); new DataView(len0.buffer).setUint32(0, preimage0.length, true);
      return this.toUnsigned("ANY", this.ix("htlc_claim_sol", keys0, concat(len0, preimage0)), "htlc_claim_sol (entrega o SOL ao recipient com a preimage)");
    }
    const program = pk(h.tokenProgram); const mint = pk(h.mint); const htlc = htlcAcc;
    const exec = this.executor?.publicKey ?? pk(h.recipient);
    const keys = [
      meta(htlc, true), meta(exec, true, true), meta(mint, false),
      meta(associatedTokenAddress(htlc, mint, program), true),
      meta(pk(h.recipient), true), meta(associatedTokenAddress(pk(h.recipient), mint, program), true),
      meta(pk(h.funder), true),
      meta(program, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
    ];
    const preimage = fromHex(preimageHex);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, preimage.length, true);
    return this.toUnsigned("ANY", this.ix("htlc_claim", keys, concat(len, preimage)), "htlc_claim (entrega ao recipient com a preimage)");
  }

  /** Refund pós-timeout — qualquer executor; devolve ao funder. */
  async buildHtlcRefund(htlcIdHex: string): Promise<UnsignedTx> {
    const h = await this.getHtlc(htlcIdHex);
    if (!h) throw new Error("HtlcNotFound");
    const htlcAcc = this.htlcPda(htlcIdHex);
    if (h.native) {
      const exec0 = this.executor?.publicKey ?? pk(h.funder);
      const keys0 = [meta(htlcAcc, true), meta(exec0, false, true), meta(pk(h.funder), true)];
      return this.toUnsigned("ANY", this.ix("htlc_refund_sol", keys0, new Uint8Array()), "htlc_refund_sol (devolve o SOL ao funder após timeout)");
    }
    const program = pk(h.tokenProgram); const mint = pk(h.mint); const htlc = htlcAcc;
    const exec = this.executor?.publicKey ?? pk(h.funder);
    const keys = [
      meta(htlc, true), meta(exec, true, true), meta(mint, false),
      meta(associatedTokenAddress(htlc, mint, program), true),
      meta(pk(h.funder), true), meta(associatedTokenAddress(pk(h.funder), mint, program), true),
      meta(program, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false),
    ];
    return this.toUnsigned("ANY", this.ix("htlc_refund", keys, new Uint8Array()), "htlc_refund (devolve ao funder após timeout)");
  }

  /** Lê o estado da perna HTLC — layout borsh de `HtlcLock` (Rust). `revealedPreimage` vazia antes
   *  do claim; `native` = perna de SOL em lamports (mint sentinela Pubkey::default()). */
  async getHtlc(htlcIdHex: string): Promise<{ htlcId: string; funder: string; recipient: string; mint: string; native: boolean; tokenProgram: string; amount: bigint; hash: string; expiresAt: number; state: "LOCKED" | "CLAIMED" | "REFUNDED"; createdAt: number; revealedPreimage: string | null } | null> {
    const info = await this.conn.getAccountInfo(this.htlcPda(htlcIdHex), this.commitment);
    if (!info) return null;
    const d = info.data; let o = 8;
    const htlcId = toHex(d.subarray(o, o + 32)); o += 32;
    const funder = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const recipient = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const mint = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const tokenProgram = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
    const amount = d.readBigUInt64LE(o); o += 8;
    const hash = toHex(d.subarray(o, o + 32)); o += 32;
    const expiresAt = Number(d.readBigInt64LE(o)); o += 8;
    const stateByte = d[o]; o += 1;
    const createdAt = Number(d.readBigInt64LE(o)); o += 8;
    const preLen = d.readUInt32LE(o); o += 4;
    const revealedPreimage = preLen > 0 ? toHex(d.subarray(o, o + preLen)) : null;
    const state = stateByte === 2 ? "CLAIMED" as const : stateByte === 3 ? "REFUNDED" as const : "LOCKED" as const;
    return { htlcId, funder, recipient, mint, native: mint === PublicKey.default.toBase58(), tokenProgram, amount, hash, expiresAt, state, createdAt, revealedPreimage };
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
  const termsVersion = d.readUInt32LE(o); o += 4; const nonce = d.readBigUInt64LE(o); o += 8;
  // Termos v2: comissões on-chain dos PMs (pagas no settle; comprador deposita junto).
  const commissionPm1 = d.readBigUInt64LE(o); o += 8;
  const commissionPm2 = d.readBigUInt64LE(o); o += 8;
  // Termos v3: hashlock cross-chain (0x0 = mesa normal).
  const htlcHashRaw = toHex(d.subarray(o, o + 32));
  const htlcHash = /^0x0+$/.test(htlcHashRaw) ? undefined : htlcHashRaw;
  return { chainId: chain.chainId, escrowAddress: programId.toBase58(), seller, buyer, paymaster01, paymaster02, sellerAsset, sellerAmount, buyerAsset, buyerAmount, platformFeeBps, commissionBps, discountBps, slippageBps, createdAt, expiresAt, termsVersion, nonce, commissionPm1, commissionPm2, htlcHash };
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
