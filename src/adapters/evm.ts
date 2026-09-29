/**
 * EvmChainAdapter — implementação REAL da porta SettlementAdapter sobre uma rede EVM de teste
 * (Sepolia/anvil) usando o contrato VerumOtcEscrow deployado (scripts/deploy-escrow.mjs).
 * O RegisterInput/termsHash é derivado com as MESMAS funções do backend (evmDealTerms), garantindo
 * que as assinaturas EIP-712 coletadas pelo Deal Engine satisfazem `approveAndSettle` on-chain.
 *
 * EvmDevKeyring — SOMENTE dev/testnet: deriva EOAs secp256k1 determinísticas por dono de slot da mesa
 * (HMAC do segredo mestre) e assina depósitos/typedData por eles. Em produção este keyring não existe:
 * cada usuário assina na própria carteira EVM (o envelope já sai pronto em /v1/deals/:id/approval-envelope).
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, defineChain, keccak256, stringToHex, isAddress, type Abi, type Chain, type PublicClient, type WalletClient, type Account } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { CanonicalAsset, ChainRef } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import { evmDealTerms, ZERO32, type Hex } from '../engines/signature.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, OnChainDealStatus, SettlementAdapter, TxRef, TxStatus } from './types.js';
import type { EvmSettings } from '../config.js';

const art = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi };
const ESCROW_ABI = art('VerumOtcEscrow').abi;
const ERC20_ABI = art('MockERC20').abi;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Hex;
const MIN_GAS_WEI = 5n * 10n ** 15n;  // 0.005 ETH: abaixo disso o keeper pré-financia a EOA dev
const TOPUP_WEI = 2n * 10n ** 16n;    // 0.02 ETH por recarga

/** Status on-chain (enum do contrato) → status da porta. */
export function mapOnChainStatus(status: number, depositedCount: number, legCount: number): OnChainDealStatus {
  switch (status) {
    case 0: return 'NONE';
    case 1: return depositedCount >= legCount && legCount > 0 ? 'FUNDED' : 'REGISTERED'; // CREATED
    case 2: case 3: case 4: case 5: case 6: return 'FUNDED';                             // LOCKED…SETTLING
    case 7: return 'SETTLED';
    case 8: case 9: return depositedCount > 0 ? 'FUNDED' : 'REGISTERED';                 // EXPIRED/REFUNDING
    case 10: return 'REFUNDED';
    default: return 'SUPERSEDED';                                                        // CANCELLED/SUPERSEDED
  }
}

/** RegisterInput do contrato a partir do commitment (mesma fonte de verdade dos testes de paridade). */
export function buildRegisterInput(c: DealCommitment, chainId: bigint, escrow: Hex) {
  const evm = evmDealTerms(c.terms, c.dealHash, c.routeHash, chainId, escrow);
  const legs = c.terms.legs.map(l => ({
    index: l.index,
    token: (l.asset.contractOrMint ?? ZERO_ADDR) as Hex,
    decimals: l.asset.decimals,
    canonicalId: keccak256(stringToHex(l.asset.assetId)),
    amount: BigInt(l.amountBase),
    isPayment: l.index === 1 // leg 1 = assetOut BUYER→SELLER (pagamento); leg 0 = entrega
  }));
  return { evm, input: { dealId: evm.dealId, revision: evm.revision, dealHash: evm.dealHash, expiresAtMs: evm.expiresAtMs, participants: evm.participants, legs, assetInHash: evm.assetInHash, assetOutHash: evm.assetOutHash, amountIn: evm.amountIn, amountOut: evm.amountOut, minAmountOut: evm.minAmountOut, referencePrice: evm.referencePrice, discountBps: evm.discountBps, feeBps: evm.feeBps, commissionBps: evm.commissionBps, commissionSplitBps: evm.commissionSplitBps, commissionAmount: evm.commissionAmount, routeHash: evm.routeHash, dealNonce: evm.dealNonce, htlcHash: evm.htlcHash, counterpartyHash: evm.counterpartyHash, sellerHash: evm.sellerHash } };
}

/** EOAs dev determinísticas por dono (endereço Solana da mesa). Chaves derivadas, nunca persistidas. */
export class EvmDevKeyring {
  private byOwner = new Map<string, PrivateKeyAccount>();
  private byAddress = new Map<string, PrivateKeyAccount>();
  constructor(private readonly masterSecret: string) {}
  accountFor(owner: string): PrivateKeyAccount {
    let acc = this.byOwner.get(owner);
    if (!acc) {
      const priv = ('0x' + bytesToHex(hmac(sha256, hexToBytes(this.masterSecret), utf8ToBytes('evm-dev|' + owner)))) as Hex;
      acc = privateKeyToAccount(priv);
      this.byOwner.set(owner, acc); this.byAddress.set(acc.address.toLowerCase(), acc);
    }
    return acc;
  }
  addressFor(owner: string): string { return this.accountFor(owner).address; }
  accountByAddress(address: string): PrivateKeyAccount | null { return this.byAddress.get(address.toLowerCase()) ?? null; }
}

interface DealCache { registerTx?: string; depositTx: Record<number, string>; settleTx?: string; refundedTx?: string }

export class EvmChainAdapter implements SettlementAdapter {
  readonly chain: ChainRef;
  private readonly viemChain: Chain;
  private readonly pub: PublicClient;
  private readonly keeperWallet: WalletClient;
  private readonly keeper: PrivateKeyAccount;
  private readonly cache = new Map<string, DealCache>();
  constructor(private readonly cfg: EvmSettings, private readonly keyring: EvmDevKeyring | null) {
    this.chain = { network: 'ethereum', chainId: cfg.chainId };
    this.viemChain = defineChain({ id: Number(cfg.chainId), name: `evm-${cfg.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
    this.pub = createPublicClient({ chain: this.viemChain, transport: http(cfg.rpcUrl) });
    this.keeper = privateKeyToAccount(cfg.keeperKey);
    this.keeperWallet = createWalletClient({ chain: this.viemChain, transport: http(cfg.rpcUrl), account: this.keeper });
  }
  private mem(dealId: string): DealCache { let c = this.cache.get(dealId); if (!c) { c = { depositTx: {} }; this.cache.set(dealId, c); } return c; }
  private fail(op: string, e: unknown): never {
    const msg = e instanceof Error ? e.message : String(e);
    const short = /reverted with the following reason:\s*([^\n]+)/.exec(msg)?.[1] ?? /Error: (\w+)\(/.exec(msg)?.[1] ?? msg.split('\n')[0];
    if (/timeout|fetch|network|ECONN|503|429/i.test(msg)) throw new DomainError('ADAPTER_UNAVAILABLE', `RPC EVM indisponível (${op})`);
    if (/Expired/.test(msg)) throw new DomainError('DEAL_EXPIRED', `expirada on-chain (${op})`);
    throw new DomainError('SETTLEMENT_FAILED', `${op} on-chain falhou: ${short}`);
  }
  private async write(fn: string, args: unknown[], account: Account = this.keeper, value?: bigint): Promise<string> {
    const wallet = account === this.keeper ? this.keeperWallet : createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account });
    const hash = await wallet.writeContract({ address: this.cfg.escrow, abi: ESCROW_ABI, functionName: fn, args, account, chain: this.viemChain, ...(value !== undefined ? { value } : {}) });
    const rc = await this.pub.waitForTransactionReceipt({ hash, confirmations: this.cfg.confirmations });
    if (rc.status !== 'success') throw new Error(`tx ${fn} revertida (${hash})`);
    return hash;
  }
  private view<T>(fn: string, args: unknown[]): Promise<T> { return this.pub.readContract({ address: this.cfg.escrow, abi: ESCROW_ABI, functionName: fn, args }) as Promise<T>; }
  /** Garante gás na EOA dev (keeper pré-financia) — só quando o keyring existe (dev). */
  private async ensureGas(address: Hex): Promise<void> {
    if (!this.keyring) return;
    const bal = await this.pub.getBalance({ address });
    if (bal >= MIN_GAS_WEI) return;
    const hash = await this.keeperWallet.sendTransaction({ to: address, value: TOPUP_WEI, account: this.keeper, chain: this.viemChain });
    await this.pub.waitForTransactionReceipt({ hash });
  }
  private devAccount(address: string): PrivateKeyAccount {
    const acc = this.keyring?.accountByAddress(address);
    if (!acc) throw new DomainError('SETTLEMENT_FAILED', `sem chave dev para ${address} — em produção o depósito é feito pela carteira do usuário`);
    return acc;
  }

  capabilities(): AdapterCapabilities { return { escrowNN: true, htlc: false, verifiableSigSchemes: ['secp256k1'], finalityConfirmations: this.cfg.confirmations, nativeCode: 'ETH' }; }
  escrowAddress(): string { return this.cfg.escrow; }
  validateAddress(address: string): boolean { return /^0x[0-9a-fA-F]{40}$/.test(address) && isAddress(address); }
  /** Mint dev (MockERC20.mint é permissionless; o keeper paga o gás). */
  async mintToken(token: Hex, to: string, amount: bigint): Promise<void> {
    try {
      const hash = await this.keeperWallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'mint', args: [to, amount], account: this.keeper, chain: this.viemChain });
      await this.pub.waitForTransactionReceipt({ hash });
    } catch (e) { this.fail('mint', e); }
  }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = Date.now(); const reasons: string[] = [];
    try {
      if (asset.network !== 'ethereum' || asset.chainId !== this.cfg.chainId) return { ok: false, reasons: ['rede/chainId não corresponde ao adaptador'], observed: { exists: false }, checkedAt };
      if (asset.contractOrMint === null) { const ok = asset.tokenStandard === 'native' && asset.code === 'ETH'; return { ok, reasons: ok ? [] : ['ativo nativo inesperado'], observed: { exists: true, standard: 'native', decimals: 18 }, checkedAt }; }
      const addr = asset.contractOrMint as Hex;
      const code = await this.pub.getCode({ address: addr });
      if (!code || code === '0x') return { ok: false, reasons: ['contrato inexistente na rede'], observed: { exists: false }, checkedAt };
      const [decimals, symbol] = await Promise.all([
        this.pub.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
        this.pub.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>
      ]);
      if (Number(decimals) !== asset.decimals) reasons.push(`decimals divergente (on-chain ${decimals}, registro ${asset.decimals})`);
      if (asset.tokenStandard !== 'ERC-20') reasons.push(`padrão divergente (esperado ERC-20, registro ${asset.tokenStandard})`);
      return { ok: reasons.length === 0, reasons, observed: { exists: true, decimals: Number(decimals), symbol, standard: 'ERC-20', codeHash: keccak256(code) }, checkedAt };
    } catch (e) { this.fail('verifyAsset', e); }
  }
  async getBalance(address: string, asset: CanonicalAsset): Promise<bigint> {
    try {
      if (asset.contractOrMint === null) return await this.pub.getBalance({ address: address as Hex });
      return await this.pub.readContract({ address: asset.contractOrMint as Hex, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }) as bigint;
    } catch (e) { this.fail('getBalance', e); }
  }
  async estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { return op === 'settle' ? '3.50' : '1.20'; }

  async registerDeal(c: DealCommitment): Promise<TxRef> {
    const mem = this.mem(c.dealId);
    const { input } = buildRegisterInput(c, BigInt(this.cfg.chainId), this.cfg.escrow);
    try {
      const tx = await this.write('register', [input]);
      mem.registerTx = tx;
      return { chain: 'ethereum', ref: tx, submittedAt: Date.now() };
    } catch (e) {
      // idempotência: já registrada nesta revisão → devolve o tx conhecido (ou referência sintética)
      const msg = e instanceof Error ? e.message : String(e);
      if (/DealExists/.test(msg)) {
        const st = await this.view<[number, number, Hex]>('dealStatus', [c.dealId]);
        if (Number(st[1]) === c.revision) return { chain: 'ethereum', ref: mem.registerTx ?? 'registered', submittedAt: Date.now() };
      }
      this.fail('register', e);
    }
  }

  async deposit(dealId: string, legIndex: number, from: string): Promise<TxRef> {
    const mem = this.mem(dealId);
    try {
      const leg = await this.view<{ index: number; token: Hex; amount: bigint; isPayment: boolean; deposited: boolean; settled: boolean }>('legOf', [dealId, legIndex]);
      if (leg.deposited) return { chain: 'ethereum', ref: mem.depositTx[legIndex] ?? 'deposited', submittedAt: Date.now() }; // idempotente
      const econ = await this.view<[bigint, bigint, bigint, bigint, number, number, number, [number, number], bigint]>('economicsOf', [dealId]);
      const due = leg.isPayment ? leg.amount + econ[8] : leg.amount; // pagamento inclui a comissão (_legDeposit)
      const acc = this.devAccount(from);
      await this.ensureGas(acc.address);
      if (leg.token !== ZERO_ADDR) {
        const wallet = createWalletClient({ chain: this.viemChain, transport: http(this.cfg.rpcUrl), account: acc });
        const ah = await wallet.writeContract({ address: leg.token, abi: ERC20_ABI, functionName: 'approve', args: [this.cfg.escrow, due], account: acc, chain: this.viemChain });
        await this.pub.waitForTransactionReceipt({ hash: ah });
      }
      const tx = await this.write('deposit', [dealId, legIndex], acc, leg.token === ZERO_ADDR ? due : 0n);
      mem.depositTx[legIndex] = tx;
      return { chain: 'ethereum', ref: tx, submittedAt: Date.now() };
    } catch (e) { this.fail('deposit', e); }
  }

  /** Uma única tx `approveAndSettle` registra as N assinaturas EIP-712 e liquida AS DUAS legs atomicamente. */
  async settle(dealId: string, _legIndex: number, signatures: ApprovalSignature[], preimage?: string): Promise<TxRef> {
    const mem = this.mem(dealId);
    const st = await this.view<[number]>('dealStatus', [dealId]);
    if (Number(st[0]) === 7) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'deal já liquidada on-chain', { tx: mem.settleTx });
    try {
      const order = { SELLER: 0, BUYER: 1, PAYMASTER_1: 2, PAYMASTER_2: 3 } as const;
      const sorted = [...signatures].sort((a, b) => order[a.role] - order[b.role]);
      const pre = preimage ? ('0x' + preimage) as Hex : ZERO32;
      const tx = await this.write('approveAndSettle', [dealId, sorted.map(s => s.signature as Hex), sorted.map(s => s.nonce), pre]);
      mem.settleTx = tx;
      return { chain: 'ethereum', ref: tx, submittedAt: Date.now() };
    } catch (e) { this.fail('settle', e); }
  }

  async refund(dealId: string, legIndex: number): Promise<TxRef> {
    try { const tx = await this.write('refund', [dealId, legIndex]); this.mem(dealId).refundedTx = tx; return { chain: 'ethereum', ref: tx, submittedAt: Date.now() }; }
    catch (e) { this.fail('refund', e); }
  }
  async supersede(dealId: string, revision: number): Promise<TxRef | null> {
    try { const tx = await this.write('supersede', [dealId, revision]); return { chain: 'ethereum', ref: tx, submittedAt: Date.now() }; }
    catch { return null; } // já assinada/estado não permite — mesma semântica do simulador
  }

  async getDealState(dealId: string): Promise<OnChainDealState> {
    try {
      const [status, revision, dealHash, , , , , depositedCount, legCount] = await this.view<[number, number, Hex, Hex, bigint, number, number, number, number]>('dealStatus', [dealId]);
      const mapped = mapOnChainStatus(Number(status), Number(depositedCount), Number(legCount));
      const mem = this.mem(dealId);
      const deposits: Record<number, string> = {}; const settledLegs: Record<number, string> = {};
      for (let i = 0; i < Number(legCount); i++) {
        const leg = await this.view<{ amount: bigint; deposited: boolean; settled: boolean }>('legOf', [dealId, i]);
        if (leg.deposited) deposits[i] = leg.amount.toString();
        if (leg.settled) settledLegs[i] = mem.settleTx ?? (await this.findSettleTx(dealId)) ?? 'onchain-settled';
      }
      // dealHash sem 0x — o SettlementEngine compara com deal.hash.dealHash (hex puro)
      return { status: mapped, revision: Number(revision), deposits, settledLegs, settledTx: mem.settleTx, refundedTx: mem.refundedTx, dealHash: dealHash === ('0x' + '00'.repeat(32)) ? undefined : dealHash.slice(2) };
    } catch (e) { this.fail('getDealState', e); }
  }
  /** Recuperação pós-restart: busca o tx de SettlementCompleted nos logs do contrato. */
  private async findSettleTx(dealId: string): Promise<string | null> {
    try {
      const logs = await this.pub.getLogs({ address: this.cfg.escrow, event: { type: 'event', name: 'SettlementCompleted', inputs: [{ name: 'dealIdHash', type: 'bytes32', indexed: true }, { name: 'revision', type: 'uint32', indexed: false }, { name: 'dealHash', type: 'bytes32', indexed: false }] }, args: { dealIdHash: keccak256(stringToHex(dealId)) }, fromBlock: 'earliest' });
      const tx = logs[logs.length - 1]?.transactionHash ?? null;
      if (tx) this.mem(dealId).settleTx = tx;
      return tx;
    } catch { return null; }
  }

  async waitFinal(ref: string): Promise<TxStatus> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) return { ref, status: 'final', confirmations: this.cfg.confirmations }; // referência sintética (idempotência)
    try {
      const rc = await this.pub.getTransactionReceipt({ hash: ref as Hex });
      const latest = await this.pub.getBlockNumber();
      const confirmations = Number(latest - rc.blockNumber) + 1;
      if (rc.status === 'reverted') return { ref, status: 'reverted', confirmations, error: 'reverted' };
      return { ref, status: confirmations >= this.cfg.confirmations ? 'final' : 'included', confirmations };
    } catch { return { ref, status: 'pending', confirmations: 0 }; }
  }
  async revealedPreimage(_dealId: string): Promise<string | null> { return null; } // rota ESCROW_NN não usa HTLC
}
