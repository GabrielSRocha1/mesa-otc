/** Harness EVM real (ethereumjs VM, Cancun) + construção de termos e assinaturas EIP-712 com as MESMAS funções do backend. */
import { readFileSync } from 'node:fs';
import { VM } from '@ethereumjs/vm';
import { Common, Chain as ChainId, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, encodeDeployData, keccak256, stringToHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';
import { computeDealHash, type Terms, type Deal } from '../src/domain/types.js';
import { envelopeFor, evmDealTerms, ZERO32, type EvmDealTerms } from '../src/engines/signature.js';
import { htlcHashOf } from '../src/engines/deal.js';
export const HTLC_PREIMAGE = 'ab'.repeat(32);

const art = (name: string) => JSON.parse(readFileSync(new URL(`../contracts/out/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: Hex };
export const ESCROW = art('VerumOtcEscrow'); export const ERC20 = art('MockERC20'); export const GUARD = art('MockPriceGuard'); export const EVIL = art('ReentrantERC20');
export const wallet = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());
const addr = (a: string) => new Address(hexToBytes(a as Hex));
export const VIEWER = '0x00000000000000000000000000000000000000ee';
export const NATIVE_ID = 'eip155:1/slip44:60'; export const NATIVE_HASH = keccak256(stringToHex(NATIVE_ID));
const errorsOf = (abi: Abi) => Object.fromEntries((abi.filter(x => x.type === 'error') as unknown as { name: string; inputs: { type: string }[] }[]).map(e => [keccak256(stringToHex(`${e.name}(${e.inputs.map(i => i.type).join(',')})`)).slice(0, 10), e.name]));
const ERRORS: Record<string, string> = { ...errorsOf(ESCROW.abi), '0x4e487b71': 'Panic', '0x08c379a0': 'Error' };

export class Chain {
  vm!: VM; ts = 1_800_000_000; contract!: string;
  async init() { this.vm = await VM.create({ common: new Common({ chain: ChainId.Mainnet, hardfork: Hardfork.Cancun }) }); }
  async fund(a: string, wei: bigint) { await this.vm.stateManager.putAccount(addr(a), new Account(0n, wei)); }
  async balance(a: string): Promise<bigint> { return (await this.vm.stateManager.getAccount(addr(a)))?.balance ?? 0n; }
  private block() { return { header: { timestamp: BigInt(this.ts), number: 1n, baseFeePerGas: 0n, gasLimit: 30_000_000n, coinbase: Address.zero(), prevRandao: new Uint8Array(32), difficulty: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n } } as unknown as Parameters<VM['evm']['runCall']>[0]['block']; }
  async deploy(from: string, a: { abi: Abi; bytecode: Hex }, args: unknown[]): Promise<string> {
    const r = await this.vm.evm.runCall({ caller: addr(from), data: hexToBytes(encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args })), gasLimit: 12_000_000n, block: this.block() });
    if (r.execResult.exceptionError) throw new Error('deploy falhou: ' + r.execResult.exceptionError.error); await this.flush(); return r.createdAddress!.toString();
  }
  private async flush() { await (this.vm.stateManager as unknown as { flush(): Promise<void> }).flush(); }
  async callTo(to: string, abi: Abi, from: string, fn: string, args: unknown[], value = 0n): Promise<{ ok: boolean; error?: string; data: Hex; logs: number }> {
    const r = await this.vm.evm.runCall({ caller: addr(from), to: addr(to), data: hexToBytes(encodeFunctionData({ abi, functionName: fn, args })), value, gasLimit: 8_000_000n, block: this.block() });
    const out = bytesToHex(r.execResult.returnValue) as Hex; if (r.execResult.exceptionError) return { ok: false, error: `${r.execResult.exceptionError.error}:${ERRORS[out.slice(0, 10)] ?? out.slice(0, 10)}`, data: out, logs: 0 };
    await this.flush(); return { ok: true, data: out, logs: r.execResult.logs?.length ?? 0 };
  }
  call(from: string, fn: string, args: unknown[], value = 0n) { return this.callTo(this.contract, ESCROW.abi, from, fn, args, value); }
  async view<T>(fn: string, args: unknown[], to = this.contract, abi = ESCROW.abi): Promise<T> { const r = await this.callTo(to, abi, VIEWER, fn, args); if (!r.ok) throw new Error(r.error); return decodeFunctionResult({ abi, functionName: fn, data: r.data }) as T; }
  async status(dealId: string) { const s = await this.view<[number, number, Hex, Hex, bigint, number, number, number, number]>('dealStatus', [dealId]); return { status: s[0], revision: s[1], dealHash: s[2], termsHash: s[3], expiresAtMs: s[4], approvals: s[5], required: s[6], deposited: s[7], legs: s[8] }; }
  async erc20(to: string, from: string, fn: string, args: unknown[]) { return this.callTo(to, ERC20.abi, from, fn, args); }
  async erc20Balance(token: string, who: string): Promise<bigint> { return this.view<bigint>('balanceOf', [who], token, ERC20.abi); }
  /** Registra um ativo passando pelo timelock de 24 h. */
  async allowAsset(admin: string, token: string, decimals: number, canonicalId: Hex) { const r = await this.call(admin, 'scheduleAsset', [token, true, decimals, canonicalId]); if (!r.ok) throw new Error(r.error); this.ts += 24 * 3600 + 1; const e = await this.call(admin, 'executeAsset', [token, true, decimals, canonicalId]); if (!e.ok) throw new Error(e.error); }
}
export const STATUS = { NONE: 0, CREATED: 1, ASSETS_LOCKED: 2, AWAITING_SIGNATURES: 3, FULLY_SIGNED: 4, VALIDATING: 5, SETTLING: 6, SETTLED: 7, EXPIRED: 8, REFUNDING: 9, REFUNDED: 10, CANCELLED: 11, SUPERSEDED: 12 } as const;

export interface DealSetup { dealId: string; terms: Terms; hash: ReturnType<typeof computeDealHash>; evm: EvmDealTerms; input: Record<string, unknown>; parts: PrivateKeyAccount[]; token: string }
export interface DealOpts { dealId?: string; participants: PrivateKeyAccount[]; token: string; tokenId: string; amountIn?: bigint; amountOut?: bigint; discountBps?: number; commissionBps?: number; split?: [number, number]; feeBps?: number; expiresAtMs?: bigint; nonce?: string; revision?: number; htlc?: boolean }
/** Constrói termos congelados (mesmo tipo Terms do backend) e deriva RegisterInput + termsHash com evmDealTerms. */
export function makeDeal(chain: Chain, o: DealOpts): DealSetup {
  const roles = ['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2'] as const; const amountIn = o.amountIn ?? 10n ** 18n; const amountOut = o.amountOut ?? 5_000_000_000n; const expiresAt = o.expiresAtMs ?? BigInt(chain.ts + 3600) * 1000n;
  const commissionBps = o.commissionBps ?? 0; const split: [number, number] = o.split ?? [commissionBps, 0];
  const terms: Terms = { schemaVersion: 1, environment: 'dev', dealId: o.dealId ?? 'OTC-' + Math.random().toString(36).slice(2, 10), revision: o.revision ?? 1, createdAt: chain.ts * 1000, expiresAt: Number(expiresAt),
    participants: o.participants.map((p, i) => ({ role: roles[i]!, network: 'ethereum', chainId: '1', address: p.address, keyScheme: 'secp256k1' })), requiredSignatures: o.participants.length,
    legs: [{ index: 0, asset: { code: 'ETH', network: 'ethereum', chainId: '1', contractOrMint: null, assetId: NATIVE_ID, decimals: 18, tokenStandard: 'native', issuer: 'native', status: 'active' }, amountBase: amountIn.toString(), from: 'SELLER', to: 'BUYER', escrowChain: 'ethereum', escrowContract: chain.contract, mode: 'ESCROW_NN' },
           { index: 1, asset: { code: 'USDC', network: 'ethereum', chainId: '1', contractOrMint: o.token, assetId: o.tokenId, decimals: 6, tokenStandard: 'ERC-20', issuer: 'Circle', status: 'active' }, amountBase: amountOut.toString(), from: 'BUYER', to: 'SELLER', escrowChain: 'ethereum', escrowContract: chain.contract, mode: 'ESCROW_NN' }],
    pricing: { referencePriceInUsd: '2418.75', referencePriceOutUsd: '1', quoteTimestamp: 1, priceValidUntil: 2, usdValueIn: '2418.75', usdValueOut: '2400', discountBps: o.discountBps ?? 100, commissionBps, commissionSplitBps: split, usdCommission: '0', platformFeeBps: o.feeBps ?? 25, paymasterShareBps: 0, maxSlippageBps: 50, maxPriceDriftBps: 100, networkCostEstimateUsd: { in: '6.8', out: '6.8' }, netAmountSellerBase: '0', priceSnapshotId: 'PS-1' },
    route: { routeId: 'RT-ESCROW_NN-ETHEREUM-ETHEREUM', kind: 'ESCROW_NN', legs: [{ escrowChain: 'ethereum', escrowContract: chain.contract, mode: 'ESCROW_NN', fundingOrder: 1, timelockSec: 3600 }], ...(o.htlc ? { htlcHash: htlcHashOf(HTLC_PREIMAGE) } : {}) }, dealNonce: o.nonce ?? Math.random().toString(16).slice(2, 18) };
  const hash = computeDealHash(terms); const evm = evmDealTerms(terms, hash.dealHash, hash.routeHash, 1n, chain.contract as Hex);
  const input = { dealId: evm.dealId, revision: evm.revision, dealHash: evm.dealHash, expiresAtMs: evm.expiresAtMs, participants: evm.participants,
    legs: [{ index: 0, token: '0x0000000000000000000000000000000000000000', decimals: 18, canonicalId: NATIVE_HASH, amount: evm.amountIn, isPayment: false }, { index: 1, token: o.token, decimals: 6, canonicalId: evm.assetOutHash, amount: evm.amountOut, isPayment: true }],
    assetInHash: evm.assetInHash, assetOutHash: evm.assetOutHash, amountIn: evm.amountIn, amountOut: evm.amountOut, minAmountOut: evm.minAmountOut, referencePrice: evm.referencePrice, discountBps: evm.discountBps, feeBps: evm.feeBps, commissionBps: evm.commissionBps, commissionSplitBps: evm.commissionSplitBps, commissionAmount: evm.commissionAmount, routeHash: evm.routeHash, dealNonce: evm.dealNonce, htlcHash: evm.htlcHash, counterpartyHash: evm.counterpartyHash, sellerHash: evm.sellerHash };
  return { dealId: terms.dealId, terms, hash, evm, input, parts: o.participants, token: o.token };
}
/** Assina o envelope EIP-712 exatamente como o backend o emite (envelopeFor). `mutate` permite simular termos adulterados. */
export async function signApproval(chain: Chain, d: DealSetup, roleIdx: number, nonce: string, mutate?: (t: Terms) => Terms): Promise<Hex> {
  const terms = mutate ? mutate(structuredClone(d.terms)) : d.terms; const dealLike = { terms, hash: mutate ? computeDealHash(terms) : d.hash } as unknown as Deal;
  const env = envelopeFor(dealLike, (['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2'] as const)[roleIdx]!, nonce, 'dev', () => chain.contract);
  return d.parts[roleIdx]!.signTypedData({ domain: env.typedData!.domain, types: env.typedData!.types, primaryType: 'DealApproval', message: env.typedData!.message });
}
export const ZERO = ZERO32;
