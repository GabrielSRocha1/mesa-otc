// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/router/src/adapters/tron.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * TronChainAdapter — deployment separado do contrato VerumOTCEscrowTron (TVM / solc 0.8.20 / paris).
 *
 * TronWeb é injetado pelo backend (interface mínima tipada abaixo) para não acoplar este pacote a
 * uma versão específica da biblioteca. O adapter nunca assina como participante: a Verum Wallet
 * assina o `triggerSmartContract`; o executor (relayer) só envia settle/expire/refund e as
 * assinaturas dos Paymasters que já chegam como bytes EIP-712 verificados on-chain.
 */
import { getAddress, type Hex } from "viem";
import { Role, TradeState, type ChainDescriptor, type Signature, type Terms, type TradeEvent, type WalletAttestation } from "../../types.js";
import { computeFee } from "../../core/index.js";
import { computeTradeIdEvm, hashTermsEvm, evmToTronAddress, tronToEvmAddress } from "../../crypto/index.js";
import type { ChainAdapter, Confirmation, OnChainTrade, PreflightReport, SubmitResult, UnsignedTx } from "../types.js";
import { EvmCalldata, toEvmTermsTuple, toEvmAttestationTuples } from "./evm.js";
import tronEscrowAbiJson from "../abi/verumOtcEscrowTron.js";

/** ABI do build Tron (contém TRON_CHAIN_ID; nunca usar o ABI EVM aqui). */
export const TRON_ESCROW_ABI = tronEscrowAbiJson as unknown[];

/** Subconjunto de TronWeb usado pelo adapter (compatível com tronweb ≥ 5). */
export interface TronWebLike {
  defaultAddress?: { base58?: string | false };
  trx: {
    getCurrentBlock(): Promise<{ block_header: { raw_data: { timestamp: number; number: number } } }>;
    getBlock(id?: string | number): Promise<{ block_header: { raw_data: { timestamp: number; number: number } } }>;
    getBalance(address: string): Promise<number>;
    getTransactionInfo(txId: string): Promise<{ id?: string; blockNumber?: number; blockTimeStamp?: number; receipt?: { result?: string }; log?: unknown[] }>;
    sign(tx: unknown, privateKey?: string): Promise<unknown>;
    sendRawTransaction(signed: unknown): Promise<{ result?: boolean; txid?: string; code?: string; message?: string }>;
  };
  transactionBuilder: {
    triggerSmartContract(
      contractAddress: string, functionSelector: string, options: Record<string, unknown>, parameters: { type: string; value: unknown }[], issuerAddress: string,
    ): Promise<{ result: { result: boolean; message?: string }; transaction: unknown }>;
    triggerConstantContract(
      contractAddress: string, functionSelector: string, options: Record<string, unknown>, parameters: { type: string; value: unknown }[], issuerAddress: string,
    ): Promise<{ result: { result: boolean; message?: string }; constant_result?: string[] }>;
  };
  contract(abi: unknown, address: string): { [fn: string]: (...args: unknown[]) => { call(): Promise<unknown> } };
  getEventResult(contractAddress: string, options: Record<string, unknown>): Promise<{ data?: TronEventRecord[] } | TronEventRecord[]>;
  address: { toHex(b58: string): string; fromHex(hex: string): string };
  toHex(v: string): string;
}

export interface TronEventRecord {
  block_number?: number; block_timestamp?: number; transaction_id?: string; event_name?: string; result?: Record<string, unknown>; event_index?: number;
}

export interface TronAdapterOptions {
  tronWeb: TronWebLike;
  abi: unknown;
  /** Chave privada do executor (relayer). Opcional: sem ela o adapter é somente leitura. */
  executorPrivateKey?: string;
  executorAddress?: string;
  /** Mínimo de TRX (em sun) por participante para energia/bandwidth. */
  minNativeSun?: number;
  feeLimitSun?: number;
}

const TERMS_TUPLE = "(address,address,address,address,address,uint256,address,uint256,uint16,uint16,uint16,uint16,uint64,uint64,uint32,uint256)";
const ATTEST_TUPLE = "(uint64,bytes)[4]";

/** Converte 'T...' ou '0x...' para o formato hex 20 bytes usado nos cálculos EIP-712. */
export function tronAddrToHex20(a: string): Hex {
  return a.startsWith("0x") ? getAddress(a) : tronToEvmAddress(a);
}

export class TronChainAdapter implements ChainAdapter {
  readonly chain: ChainDescriptor;
  readonly escrowBase58: string;
  readonly escrowHex: Hex;
  private readonly tw: TronWebLike;
  private readonly abi: unknown;
  private readonly executorKey: string | undefined;
  private readonly executorAddress: string | undefined;
  private readonly minNativeSun: number;
  private readonly feeLimitSun: number;

  constructor(chain: ChainDescriptor, opts: TronAdapterOptions) {
    if (chain.kind !== "TRON") throw new Error(`TronChainAdapter requer chain TRON (recebido ${chain.kind})`);
    this.chain = chain;
    this.escrowBase58 = chain.escrowAddress.startsWith("0x") ? evmToTronAddress(chain.escrowAddress as Hex) : chain.escrowAddress;
    this.escrowHex = tronAddrToHex20(chain.escrowAddress);
    this.tw = opts.tronWeb;
    this.abi = opts.abi;
    this.executorKey = opts.executorPrivateKey;
    this.executorAddress = opts.executorAddress ?? (opts.tronWeb.defaultAddress?.base58 || undefined);
    this.minNativeSun = opts.minNativeSun ?? 50_000_000; // 50 TRX
    this.feeLimitSun = opts.feeLimitSun ?? 150_000_000;
  }

  /** Termos com endereços normalizados para 20 bytes hex (o contrato TVM e o EIP-712 trabalham em hex). */
  private hexTerms(t: Terms): Terms {
    return { ...t, escrowAddress: this.escrowHex, seller: tronAddrToHex20(t.seller), buyer: tronAddrToHex20(t.buyer), paymaster01: tronAddrToHex20(t.paymaster01),
      paymaster02: tronAddrToHex20(t.paymaster02), sellerAsset: tronAddrToHex20(t.sellerAsset), buyerAsset: tronAddrToHex20(t.buyerAsset) };
  }

  computeIds(terms: Terms): { tradeId: string; termsHash: string } {
    const termsHash = hashTermsEvm(this.hexTerms(terms));
    return { termsHash, tradeId: computeTradeIdEvm(this.chain.chainId, this.escrowHex, termsHash) };
  }

  async preflight(t: Terms): Promise<PreflightReport> {
    const issues: PreflightReport["issues"] = [];
    const c = this.tw.contract(this.abi, this.escrowBase58);
    const [block, paused, feeBps, sellerActive, buyerActive] = await Promise.all([
      this.tw.trx.getCurrentBlock(),
      c.paused!().call() as Promise<boolean>,
      c.platformFeeBps!().call() as Promise<number | bigint>,
      c.isTokenActive!(tronAddrToHex20(t.sellerAsset)).call() as Promise<boolean>,
      c.isTokenActive!(tronAddrToHex20(t.buyerAsset)).call() as Promise<boolean>,
    ]);
    if (!sellerActive) issues.push({ code: "TOKEN_NOT_AUTHORIZED", message: `sellerAsset ${t.sellerAsset} não ACTIVE no registry on-chain (Tron)` });
    if (!buyerActive) issues.push({ code: "TOKEN_NOT_AUTHORIZED", message: `buyerAsset ${t.buyerAsset} não ACTIVE no registry on-chain (Tron)` });

    const need = t.sellerAmount + computeFee(t.sellerAmount, t.platformFeeBps);
    const sellerTok = this.tw.contract(ERC20_ABI_TRON, this.toB58(t.sellerAsset));
    const buyerTok = this.tw.contract(ERC20_ABI_TRON, this.toB58(t.buyerAsset));
    const [sBal, sAllow, bBal, bAllow] = (await Promise.all([
      sellerTok.balanceOf!(this.toB58(t.seller)).call(), sellerTok.allowance!(this.toB58(t.seller), this.escrowBase58).call(),
      buyerTok.balanceOf!(this.toB58(t.buyer)).call(), buyerTok.allowance!(this.toB58(t.buyer), this.escrowBase58).call(),
    ])).map((x) => BigInt((x as { toString(): string }).toString()));
    if (sBal! < need) issues.push({ code: "SELLER_BALANCE", message: `seller tem ${sBal}, precisa de ${need}`, role: Role.SELLER });
    if (sAllow! < need) issues.push({ code: "SELLER_ALLOWANCE", message: `approve(escrow, ${need}) pendente`, role: Role.SELLER });
    if (bBal! < t.buyerAmount) issues.push({ code: "BUYER_BALANCE", message: `buyer tem ${bBal}, precisa de ${t.buyerAmount}`, role: Role.BUYER });
    if (bAllow! < t.buyerAmount) issues.push({ code: "BUYER_ALLOWANCE", message: `approve(escrow, ${t.buyerAmount}) pendente`, role: Role.BUYER });

    const roles = [[t.seller, Role.SELLER], [t.paymaster01, Role.PAYMASTER_01], [t.paymaster02, Role.PAYMASTER_02], [t.buyer, Role.BUYER]] as const;
    const trx = await Promise.all(roles.map(([w]) => this.tw.trx.getBalance(this.toB58(w))));
    trx.forEach((n, i) => { if (n < this.minNativeSun) issues.push({ code: "NO_GAS", message: `${roles[i]![0]} abaixo do mínimo de TRX para energia`, role: roles[i]![1] }); });

    return { ok: issues.length === 0, issues, chainNow: Math.floor(block.block_header.raw_data.timestamp / 1000), paused, onChainFeeBps: Number(feeBps) };
  }

  async buildCreateTrade(terms: Terms, attestations: [WalletAttestation, WalletAttestation, WalletAttestation, WalletAttestation]): Promise<UnsignedTx> {
    const ht = this.hexTerms(terms);
    const tuple = toEvmTermsTuple(ht);
    return this.tx(terms.paymaster01, `createTrade(${TERMS_TUPLE},${ATTEST_TUPLE})`, [
      { type: TERMS_TUPLE, value: [tuple.seller, tuple.buyer, tuple.paymaster01, tuple.paymaster02, tuple.sellerAsset, tuple.sellerAmount.toString(), tuple.buyerAsset,
        tuple.buyerAmount.toString(), tuple.platformFeeBps, tuple.commissionBps, tuple.discountBps, tuple.slippageBps, tuple.createdAt.toString(), tuple.expiresAt.toString(), tuple.termsVersion, tuple.nonce.toString()] },
      { type: ATTEST_TUPLE, value: toEvmAttestationTuples(attestations).map((a) => [a.validUntil.toString(), a.signature]) },
    ], EvmCalldata.createTrade(ht, attestations), "createTrade (PAYMASTER_01)");
  }

  async buildSign(terms: Terms, tradeId: string, approval: Signature): Promise<UnsignedTx> {
    if (approval.tradeId !== tradeId) throw new Error("approval.tradeId ≠ tradeId");
    const fn = (["sellerSign", "paymaster01Sign", "paymaster02Sign", "buyerSign"] as const)[approval.role];
    const signer = approval.role === Role.SELLER ? terms.seller : approval.role === Role.BUYER ? terms.buyer : "ANY";
    return this.tx(signer, `${fn}(bytes32,uint64,bytes)`, [
      { type: "bytes32", value: approval.tradeId }, { type: "uint64", value: String(approval.deadline) }, { type: "bytes", value: approval.signature },
    ], EvmCalldata.sign(approval), fn);
  }
  async buildSettle(tradeId: string): Promise<UnsignedTx> { return this.tx("ANY", "settle(bytes32)", [{ type: "bytes32", value: tradeId }], EvmCalldata.settle(tradeId), "settle"); }
  async buildExpire(tradeId: string): Promise<UnsignedTx> { return this.tx("ANY", "expireTrade(bytes32)", [{ type: "bytes32", value: tradeId }], EvmCalldata.expire(tradeId), "expireTrade"); }
  async buildRefund(tradeId: string): Promise<UnsignedTx> { return this.tx("ANY", "refund(bytes32)", [{ type: "bytes32", value: tradeId }], EvmCalldata.refund(tradeId), "refund"); }

  async submitAsExecutor(tx: UnsignedTx): Promise<SubmitResult> {
    if (!this.executorKey || !this.executorAddress) throw new Error("adapter Tron em modo somente leitura: sem executor");
    if (tx.signer !== "ANY" && this.toB58(tx.signer) !== this.executorAddress) throw new Error(`transação exige o participante ${tx.signer}`);
    const p = tx.payload as { functionSelector: string; parameters: { type: string; value: unknown }[] };
    const built = await this.tw.transactionBuilder.triggerSmartContract(this.escrowBase58, p.functionSelector, { feeLimit: this.feeLimitSun, callValue: 0 }, p.parameters, this.executorAddress);
    if (!built.result?.result) throw new Error(`triggerSmartContract falhou: ${built.result?.message ?? "sem detalhes"}`);
    const signed = await this.tw.trx.sign(built.transaction, this.executorKey);
    const sent = await this.tw.trx.sendRawTransaction(signed);
    if (!sent.result || !sent.txid) throw new Error(`broadcast falhou: ${sent.code ?? ""} ${sent.message ?? ""}`);
    return { txHash: sent.txid };
  }

  async getTrade(tradeId: string): Promise<OnChainTrade | null> {
    const c = this.tw.contract(this.abi, this.escrowBase58);
    const raw = (await c.getTrade!(tradeId).call()) as { terms: { expiresAt: unknown }; termsHash: string; state: unknown; sellerDeposited: boolean; buyerDeposited: boolean; feeCollected: boolean; feeAmount: unknown; settledAt: unknown; expiredAt: unknown } | null;
    if (!raw) return null;
    const state = Number(raw.state) as TradeState;
    if (state === TradeState.NONE) return null;
    const n = (x: unknown) => Number((x as { toString(): string }).toString());
    return {
      tradeId, state, termsHash: raw.termsHash.startsWith("0x") ? raw.termsHash : `0x${raw.termsHash}`,
      sellerDeposited: raw.sellerDeposited, buyerDeposited: raw.buyerDeposited, feeCollected: raw.feeCollected,
      feeAmount: BigInt((raw.feeAmount as { toString(): string }).toString()), expiresAt: n(raw.terms.expiresAt), settledAt: n(raw.settledAt), expiredAt: n(raw.expiredAt),
    };
  }

  async waitForConfirmation(txHash: string, timeoutMs: number): Promise<Confirmation> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const info = await this.tw.trx.getTransactionInfo(txHash);
      if (info && info.id && info.blockNumber) {
        const head = (await this.tw.trx.getCurrentBlock()).block_header.raw_data.number;
        const confirmations = head - info.blockNumber + 1;
        if (confirmations < this.chain.requiredConfirmations) { await sleep(3000); continue; }
        const ok = (info.receipt?.result ?? "SUCCESS") === "SUCCESS";
        return ok ? { txHash, status: "CONFIRMED", confirmations, blockNumber: info.blockNumber } : { txHash, status: "FAILED", confirmations, blockNumber: info.blockNumber, reason: String(info.receipt?.result ?? "REVERT") };
      }
      await sleep(3000);
    }
    return { txHash, status: "TIMEOUT", confirmations: 0, reason: `sem confirmação em ${timeoutMs} ms` };
  }

  async fetchEvents(tradeId: string): Promise<TradeEvent[]> {
    const res = await this.tw.getEventResult(this.escrowBase58, { onlyConfirmed: true, limit: 200, orderBy: "block_timestamp,asc" });
    const list: TronEventRecord[] = Array.isArray(res) ? res : (res.data ?? []);
    const want = tradeId.replace(/^0x/, "").toLowerCase();
    return list
      .filter((e) => String((e.result ?? {}).tradeId ?? "").replace(/^0x/, "").toLowerCase() === want)
      .map((e, i) => {
        const data: TradeEvent["data"] = {};
        for (const [k, v] of Object.entries(e.result ?? {})) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") data[k] = v;
        return { name: e.event_name as TradeEvent["name"], chainId: this.chain.chainId, tradeId, txHash: e.transaction_id ?? "", blockNumber: e.block_number ?? 0,
          logIndex: e.event_index ?? i, timestamp: Math.floor((e.block_timestamp ?? 0) / 1000), data };
      });
  }

  async now(): Promise<number> { return Math.floor((await this.tw.trx.getCurrentBlock()).block_header.raw_data.timestamp / 1000); }

  // ----------------------------------------------------------------
  private toB58(a: string): string { return a.startsWith("0x") ? evmToTronAddress(getAddress(a)) : a; }
  private tx(signer: string | "ANY", functionSelector: string, parameters: { type: string; value: unknown }[], rawCalldata: Hex, description: string): UnsignedTx {
    return {
      chainId: this.chain.chainId, signer,
      payload: { contract: this.escrowBase58, contractHex: this.escrowHex, functionSelector, parameters, rawCalldata, feeLimit: this.feeLimitSun, callValue: 0 },
      description,
    };
  }
}

const ERC20_ABI_TRON = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
