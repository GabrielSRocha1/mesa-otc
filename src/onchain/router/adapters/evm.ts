// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/router/src/adapters/evm.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * EvmChainAdapter — um adapter por deployment (Ethereum, BNB, Polygon, Arbitrum …).
 * O MESMO código Solidity é implantado separadamente em cada rede; este adapter apenas
 * (1) constrói calldata, (2) lê estado/eventos e (3) submete transações de executor sem custódia.
 *
 * Nunca assina como participante. As assinaturas EIP-712 dos participantes chegam prontas
 * (Verum Wallet) e são apenas encaminhadas ao contrato, que é quem verifica.
 */
import {
  createPublicClient, createWalletClient, http, encodeFunctionData, parseEventLogs, getAddress, isAddress,
  type Abi, type Hex, type PublicClient, type WalletClient, type Account, type Chain, type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Role, TradeState, type ChainDescriptor, type Signature, type Terms, type TradeEvent, type WalletAttestation } from "../../types.js";
import { computeFee } from "../../core/index.js";
import { computeTradeIdEvm, hashTermsEvm } from "../../crypto/index.js";
import type { ChainAdapter, Confirmation, OnChainTrade, PreflightReport, SubmitResult, UnsignedTx } from "../types.js";
import escrowAbiJson from "../abi/verumOtcEscrowEvm.js";

export const ESCROW_ABI = escrowAbiJson as Abi;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const satisfies Abi;

const SIGN_FN: Record<Role, "sellerSign" | "paymaster01Sign" | "paymaster02Sign" | "buyerSign"> = {
  [Role.SELLER]: "sellerSign",
  [Role.PAYMASTER_01]: "paymaster01Sign",
  [Role.PAYMASTER_02]: "paymaster02Sign",
  [Role.BUYER]: "buyerSign",
};

/** Gás mínimo aproximado (wei) que cada participante deve ter para suas próprias transações. */
export const DEFAULT_MIN_NATIVE_WEI = 1_000_000_000_000_000n / 1000n; // 0,001 unidade nativa

export interface EvmAdapterOptions {
  rpcUrl?: string;
  publicClient?: PublicClient;
  /** Chave do executor (relayer de Paymaster / sweeper). NUNCA é chave de participante. Opcional (modo somente leitura). */
  executorPrivateKey?: Hex;
  walletClient?: WalletClient<Transport, Chain | undefined, Account>;
  minNativeWei?: bigint;
  /** Bloco a partir do qual procurar eventos (deployment block). */
  deploymentBlock?: bigint;
  pollingIntervalMs?: number;
}

export interface EvmTermsTuple {
  seller: Hex; buyer: Hex; paymaster01: Hex; paymaster02: Hex; sellerAsset: Hex; sellerAmount: bigint; buyerAsset: Hex; buyerAmount: bigint;
  platformFeeBps: number; commissionBps: number; discountBps: number; slippageBps: number; createdAt: bigint; expiresAt: bigint; termsVersion: number; nonce: bigint;
}

const addr = (a: string): Hex => { if (!isAddress(a)) throw new Error(`endereço EVM inválido: ${a}`); return getAddress(a); };

/** Converte Terms (tipos TS) para o tuple ABI do contrato — função pura, reutilizada pelo adapter Tron. */
export function toEvmTermsTuple(t: Terms): EvmTermsTuple {
  return {
    seller: addr(t.seller), buyer: addr(t.buyer), paymaster01: addr(t.paymaster01), paymaster02: addr(t.paymaster02),
    sellerAsset: addr(t.sellerAsset), sellerAmount: t.sellerAmount, buyerAsset: addr(t.buyerAsset), buyerAmount: t.buyerAmount,
    platformFeeBps: t.platformFeeBps, commissionBps: t.commissionBps, discountBps: t.discountBps, slippageBps: t.slippageBps,
    createdAt: BigInt(t.createdAt), expiresAt: BigInt(t.expiresAt), termsVersion: t.termsVersion, nonce: t.nonce,
  };
}

export function toEvmAttestationTuples(a: readonly WalletAttestation[]): { validUntil: bigint; signature: Hex }[] {
  if (a.length !== 4) throw new Error("exatamente 4 atestados são necessários");
  return a.map((x) => ({ validUntil: BigInt(x.validUntil), signature: x.signature as Hex }));
}

/** Calldata puro (sem RPC) — usado por EVM e Tron e testável offline. */
export const EvmCalldata = {
  createTrade(terms: Terms, attestations: readonly WalletAttestation[]): Hex {
    return encodeFunctionData({ abi: ESCROW_ABI, functionName: "createTrade", args: [toEvmTermsTuple(terms), toEvmAttestationTuples(attestations)] });
  },
  sign(approval: Signature): Hex {
    return encodeFunctionData({ abi: ESCROW_ABI, functionName: SIGN_FN[approval.role], args: [approval.tradeId as Hex, BigInt(approval.deadline), approval.signature as Hex] });
  },
  settle(tradeId: string): Hex { return encodeFunctionData({ abi: ESCROW_ABI, functionName: "settle", args: [tradeId as Hex] }); },
  expire(tradeId: string): Hex { return encodeFunctionData({ abi: ESCROW_ABI, functionName: "expireTrade", args: [tradeId as Hex] }); },
  refund(tradeId: string): Hex { return encodeFunctionData({ abi: ESCROW_ABI, functionName: "refund", args: [tradeId as Hex] }); },
  expireAndRefund(tradeId: string): Hex { return encodeFunctionData({ abi: ESCROW_ABI, functionName: "expireAndRefund", args: [tradeId as Hex] }); },
};

interface RawTrade {
  terms: EvmTermsTuple; termsHash: Hex; state: number; sellerDeposited: boolean; buyerDeposited: boolean; feeCollected: boolean;
  feeAmount: bigint; settledAt: bigint; expiredAt: bigint;
}

export class EvmChainAdapter implements ChainAdapter {
  readonly chain: ChainDescriptor;
  readonly escrow: Hex;
  private readonly pub: PublicClient;
  private readonly wallet?: WalletClient<Transport, Chain | undefined, Account>;
  private readonly minNativeWei: bigint;
  private readonly deploymentBlock: bigint;
  private readonly pollingIntervalMs: number;

  constructor(chain: ChainDescriptor, opts: EvmAdapterOptions = {}) {
    if (chain.kind !== "EVM") throw new Error(`EvmChainAdapter requer chain EVM (recebido ${chain.kind})`);
    this.chain = chain;
    this.escrow = addr(chain.escrowAddress);
    this.pub = opts.publicClient ?? createPublicClient({ transport: http(opts.rpcUrl ?? chain.rpcUrl) });
    if (opts.walletClient) this.wallet = opts.walletClient;
    else if (opts.executorPrivateKey) {
      this.wallet = createWalletClient({ account: privateKeyToAccount(opts.executorPrivateKey), transport: http(opts.rpcUrl ?? chain.rpcUrl) });
    }
    this.minNativeWei = opts.minNativeWei ?? DEFAULT_MIN_NATIVE_WEI;
    this.deploymentBlock = opts.deploymentBlock ?? 0n;
    this.pollingIntervalMs = opts.pollingIntervalMs ?? 4000;
  }

  computeIds(terms: Terms): { tradeId: string; termsHash: string } {
    const termsHash = hashTermsEvm(terms);
    return { termsHash, tradeId: computeTradeIdEvm(this.chain.chainId, this.escrow, termsHash) };
  }

  /** Garante que o contrato alvo é realmente um deployment desta rede (chain id validado on-chain). */
  async assertDeployment(): Promise<void> {
    const [rpcChainId, expected] = await Promise.all([
      this.pub.getChainId(),
      this.pub.readContract({ address: this.escrow, abi: ESCROW_ABI, functionName: "EXPECTED_CHAIN_ID" }) as Promise<bigint>,
    ]);
    if (BigInt(rpcChainId) !== BigInt(this.chain.chainId) || expected !== BigInt(this.chain.chainId)) {
      throw new Error(`WRONG_CHAIN: rpc=${rpcChainId} contrato=${expected} esperado=${this.chain.chainId}`);
    }
  }

  async preflight(t: Terms): Promise<PreflightReport> {
    const issues: PreflightReport["issues"] = [];
    const [block, paused, feeBps, sellerActive, buyerActive, chainId] = await Promise.all([
      this.pub.getBlock({ blockTag: "latest" }),
      this.read<boolean>("paused"),
      this.read<number>("platformFeeBps"),
      this.read<boolean>("isTokenActive", [addr(t.sellerAsset)]),
      this.read<boolean>("isTokenActive", [addr(t.buyerAsset)]),
      this.pub.getChainId(),
    ]);
    if (BigInt(chainId) !== BigInt(this.chain.chainId)) issues.push({ code: "WRONG_CHAIN", message: `RPC responde chain ${chainId}, esperado ${this.chain.chainId}` });
    if (!sellerActive) issues.push({ code: "TOKEN_NOT_AUTHORIZED", message: `sellerAsset ${t.sellerAsset} não está ACTIVE no registry on-chain` });
    if (!buyerActive) issues.push({ code: "TOKEN_NOT_AUTHORIZED", message: `buyerAsset ${t.buyerAsset} não está ACTIVE no registry on-chain` });

    const need = t.sellerAmount + computeFee(t.sellerAmount, t.platformFeeBps);
    const [sBal, sAllow, bBal, bAllow] = await Promise.all([
      this.erc20<bigint>(t.sellerAsset, "balanceOf", [addr(t.seller)]),
      this.erc20<bigint>(t.sellerAsset, "allowance", [addr(t.seller), this.escrow]),
      this.erc20<bigint>(t.buyerAsset, "balanceOf", [addr(t.buyer)]),
      this.erc20<bigint>(t.buyerAsset, "allowance", [addr(t.buyer), this.escrow]),
    ]);
    if (sBal < need) issues.push({ code: "SELLER_BALANCE", message: `seller tem ${sBal}, precisa de ${need} (principal + fee)`, role: Role.SELLER });
    if (sAllow < need) issues.push({ code: "SELLER_ALLOWANCE", message: `approve(escrow, ${need}) pendente para o seller`, role: Role.SELLER });
    if (bBal < t.buyerAmount) issues.push({ code: "BUYER_BALANCE", message: `buyer tem ${bBal}, precisa de ${t.buyerAmount}`, role: Role.BUYER });
    if (bAllow < t.buyerAmount) issues.push({ code: "BUYER_ALLOWANCE", message: `approve(escrow, ${t.buyerAmount}) pendente para o buyer`, role: Role.BUYER });

    const roles = [[t.seller, Role.SELLER], [t.paymaster01, Role.PAYMASTER_01], [t.paymaster02, Role.PAYMASTER_02], [t.buyer, Role.BUYER]] as const;
    const natives = await Promise.all(roles.map(([w]) => this.pub.getBalance({ address: addr(w) })));
    natives.forEach((n, i) => { if (n < this.minNativeWei) issues.push({ code: "NO_GAS", message: `${roles[i]![0]} abaixo do mínimo nativo para gás`, role: roles[i]![1] }); });

    return { ok: issues.length === 0, issues, chainNow: Number(block.timestamp), paused, onChainFeeBps: Number(feeBps) };
  }

  async buildCreateTrade(terms: Terms, attestations: [WalletAttestation, WalletAttestation, WalletAttestation, WalletAttestation]): Promise<UnsignedTx> {
    return this.tx(terms.paymaster01, EvmCalldata.createTrade(terms, attestations), "createTrade — assinado e enviado pelo PAYMASTER_01 (criador da mesa)");
  }
  async buildSign(terms: Terms, tradeId: string, approval: Signature): Promise<UnsignedTx> {
    if (approval.tradeId !== tradeId) throw new Error("approval.tradeId ≠ tradeId");
    const signer = approval.role === Role.SELLER ? terms.seller : approval.role === Role.BUYER ? terms.buyer : "ANY";
    return this.tx(signer, EvmCalldata.sign(approval), `${SIGN_FN[approval.role]} (assinatura EIP-712 verificada on-chain)`);
  }
  async buildSettle(tradeId: string): Promise<UnsignedTx> { return this.tx("ANY", EvmCalldata.settle(tradeId), "settle — qualquer executor"); }
  async buildExpire(tradeId: string): Promise<UnsignedTx> { return this.tx("ANY", EvmCalldata.expire(tradeId), "expireTrade — qualquer executor, destino fixo on-chain"); }
  async buildRefund(tradeId: string): Promise<UnsignedTx> { return this.tx("ANY", EvmCalldata.refund(tradeId), "refund — devolve principais às carteiras de origem"); }

  async submitAsExecutor(tx: UnsignedTx): Promise<SubmitResult> {
    if (!this.wallet) throw new Error("adapter em modo somente leitura: sem chave de executor");
    if (tx.signer !== "ANY" && getAddress(tx.signer) !== getAddress(this.wallet.account.address)) {
      throw new Error(`transação exige o participante ${tx.signer}; o executor não pode assinar por ele`);
    }
    const p = tx.payload as { to: Hex; data: Hex; value: string };
    // Simulação primeiro: um revert aqui evita gastar gás e já expõe o erro customizado do contrato.
    await this.pub.call({ account: this.wallet.account, to: p.to, data: p.data });
    const txHash = await this.wallet.sendTransaction({ to: p.to, data: p.data, value: BigInt(p.value), chain: this.wallet.chain ?? undefined, account: this.wallet.account });
    return { txHash };
  }

  async getTrade(tradeId: string): Promise<OnChainTrade | null> {
    const raw = await this.read<RawTrade>("getTrade", [tradeId as Hex]);
    if (!raw || Number(raw.state) === TradeState.NONE) return null;
    return {
      tradeId, state: Number(raw.state) as TradeState, termsHash: raw.termsHash, sellerDeposited: raw.sellerDeposited,
      buyerDeposited: raw.buyerDeposited, feeCollected: raw.feeCollected, feeAmount: raw.feeAmount,
      expiresAt: Number(raw.terms.expiresAt), settledAt: Number(raw.settledAt), expiredAt: Number(raw.expiredAt),
    };
  }

  async waitForConfirmation(txHash: string, timeoutMs: number): Promise<Confirmation> {
    try {
      const receipt = await this.pub.waitForTransactionReceipt({
        hash: txHash as Hex, confirmations: this.chain.requiredConfirmations, timeout: timeoutMs, pollingInterval: this.pollingIntervalMs,
      });
      const head = await this.pub.getBlockNumber();
      const confirmations = Number(head - receipt.blockNumber) + 1;
      return receipt.status === "success"
        ? { txHash, status: "CONFIRMED", confirmations, blockNumber: Number(receipt.blockNumber) }
        : { txHash, status: "FAILED", confirmations, blockNumber: Number(receipt.blockNumber), reason: "revert" };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      return /timed out|timeout/i.test(msg) ? { txHash, status: "TIMEOUT", confirmations: 0, reason: msg } : { txHash, status: "FAILED", confirmations: 0, reason: msg };
    }
  }

  async fetchEvents(tradeId: string): Promise<TradeEvent[]> {
    const logs = await this.pub.getLogs({ address: this.escrow, fromBlock: this.deploymentBlock, toBlock: "latest" });
    const parsed = parseEventLogs({ abi: ESCROW_ABI, logs });
    const out: TradeEvent[] = [];
    const blockTs = new Map<bigint, number>();
    for (const l of parsed) {
      const args = (l as unknown as { args: Record<string, unknown> }).args ?? {};
      const id = args.tradeId as string | undefined;
      if (!id || id.toLowerCase() !== tradeId.toLowerCase()) continue;
      if (!blockTs.has(l.blockNumber)) blockTs.set(l.blockNumber, Number((await this.pub.getBlock({ blockNumber: l.blockNumber })).timestamp));
      const data: TradeEvent["data"] = {};
      for (const [k, v] of Object.entries(args)) if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") data[k] = v;
      out.push({
        name: l.eventName as TradeEvent["name"], chainId: this.chain.chainId, tradeId, txHash: l.transactionHash,
        blockNumber: Number(l.blockNumber), logIndex: l.logIndex, timestamp: blockTs.get(l.blockNumber)!, data,
      });
    }
    return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }

  async now(): Promise<number> { return Number((await this.pub.getBlock({ blockTag: "latest" })).timestamp); }

  // ----------------------------------------------------------------
  private tx(signer: string | "ANY", data: Hex, description: string): UnsignedTx {
    return { chainId: this.chain.chainId, signer, payload: { to: this.escrow, data, value: "0", chainId: this.chain.chainId }, description };
  }
  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.escrow, abi: ESCROW_ABI, functionName, args }) as Promise<T>;
  }
  private erc20<T>(token: string, functionName: "balanceOf" | "allowance" | "decimals", args: readonly unknown[]): Promise<T> {
    return this.pub.readContract({ address: addr(token), abi: ERC20_ABI, functionName, args: args as never }) as Promise<T>;
  }
}
