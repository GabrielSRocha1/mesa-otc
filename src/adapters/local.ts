/**
 * Simuladores locais de cadeia (dev/teste) que implementam a porta SettlementAdapter com a MESMA semântica dos
 * contratos: recomputação do dealHash a partir do commitment armazenado, N-de-N por papel, expiração, status,
 * nonce consumido, dupla liquidação rejeitada, refund permissionless após expiração, HTLC para Bitcoin.
 * Injeção de falhas: rpcDown, settleReverts, reorgAfterSettle — para testar recuperação.
 */
import { sha256Hex, canonicalize, legHashOf, ROLE_ORDER, NETWORK_KEY_SCHEME, type CanonicalAsset, type ChainRef, type KeyScheme, type Network, type Role } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { AdapterCapabilities, ApprovalSignature, ApprovalVerifier, AssetVerification, DealCommitment, OnChainDealState, SettlementAdapter, TxRef, TxStatus } from './types.js';

export interface LocalToken { contract: string; symbol: string; decimals: number; standard: string; codeHash: string; mintAuthority?: string | null; hooks?: boolean }
export interface LocalFaults { rpcDown?: boolean; settleReverts?: boolean; reorgAfterSettle?: boolean; slowFinality?: boolean }

interface StoredDeal { commit: DealCommitment; status: OnChainDealState['status']; deposits: Record<number, string>; depositTx: Record<number, string>; settledLegs: Record<number, string>; settledTx?: string; refundedTx?: string; usedNonces: Set<string>; preimage?: string; htlc?: { hash: string; timelock: number; locked: boolean } }

const ADDR_RULES: Record<Network, RegExp> = {
  ethereum: /^0x[0-9a-fA-F]{40}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, bitcoin: /^(bc1[0-9a-z]{25,62}|bcrt1[0-9a-z]{25,62}|tb1[0-9a-z]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, zcash: /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/
};

export class LocalChainAdapter implements SettlementAdapter {
  readonly chain: ChainRef;
  faults: LocalFaults = {};
  private tokens = new Map<string, LocalToken>();
  private balances = new Map<string, bigint>();
  private deals = new Map<string, StoredDeal>();
  private txs = new Map<string, TxStatus>();
  private txSeq = 0;
  now: () => number = () => Date.now();
  constructor(network: Network, chainId: string, private readonly escrow: string, private readonly verifier: ApprovalVerifier, private readonly opts: { finality: number; nativeCode: string; htlc: boolean; escrowNN: boolean; verifiable: KeyScheme[] }) { this.chain = { network, chainId }; }

  /* ---- setup de teste ---- */
  addToken(t: LocalToken): this { this.tokens.set(t.contract, t); return this; }
  mint(address: string, contractOrMint: string | null, amount: bigint): this { const k = `${contractOrMint ?? 'native'}|${address}`; this.balances.set(k, (this.balances.get(k) ?? 0n) + amount); return this; }
  balanceOf(address: string, contractOrMint: string | null): bigint { return this.balances.get(`${contractOrMint ?? 'native'}|${address}`) ?? 0n; }
  private move(contract: string | null, from: string, to: string, amount: bigint): void { const kf = `${contract ?? 'native'}|${from}`; const bal = this.balances.get(kf) ?? 0n; if (bal < amount) throw new DomainError('SETTLEMENT_FAILED', 'saldo insuficiente on-chain', { from, amount: amount.toString() }); this.balances.set(kf, bal - amount); const kt = `${contract ?? 'native'}|${to}`; this.balances.set(kt, (this.balances.get(kt) ?? 0n) + amount); }
  private rpc(): void { if (this.faults.rpcDown) throw new DomainError('ADAPTER_UNAVAILABLE', `RPC ${this.chain.network} indisponível`); }
  private tx(ok = true, err?: string): TxRef { this.txSeq += 1; const ref = (this.chain.network === 'solana' ? '' : '0x') + sha256Hex(`${this.chain.network}:${this.txSeq}:${this.now()}`).slice(0, this.chain.network === 'solana' ? 64 : 64); this.txs.set(ref, { ref, status: ok ? 'final' : 'reverted', confirmations: ok ? this.opts.finality : 0, error: err }); return { chain: this.chain.network, ref, submittedAt: this.now() }; }

  capabilities(): AdapterCapabilities { return { escrowNN: this.opts.escrowNN, htlc: this.opts.htlc, verifiableSigSchemes: this.opts.verifiable, finalityConfirmations: this.opts.finality, nativeCode: this.opts.nativeCode }; }
  escrowAddress(): string { return this.escrow; }
  validateAddress(address: string): boolean { return ADDR_RULES[this.chain.network].test(address); }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    this.rpc(); const reasons: string[] = []; const checkedAt = this.now();
    if (asset.network !== this.chain.network || asset.chainId !== this.chain.chainId) { reasons.push('rede/chainId não corresponde ao adaptador'); return { ok: false, reasons, observed: { exists: false }, checkedAt }; }
    if (asset.contractOrMint === null) { const ok = asset.tokenStandard === 'native' && asset.code === this.opts.nativeCode; if (!ok) reasons.push('ativo nativo inesperado para esta rede'); return { ok, reasons, observed: { exists: true, standard: 'native', decimals: asset.decimals }, checkedAt }; }
    const t = this.tokens.get(asset.contractOrMint);
    if (!t) { reasons.push('contrato/mint inexistente na rede'); return { ok: false, reasons, observed: { exists: false }, checkedAt }; }
    if (t.decimals !== asset.decimals) reasons.push(`decimals divergente (on-chain ${t.decimals}, registro ${asset.decimals})`);
    if (t.standard !== asset.tokenStandard) reasons.push(`padrão divergente (on-chain ${t.standard}, registro ${asset.tokenStandard})`);
    if (asset.expectedCodeHash && t.codeHash !== asset.expectedCodeHash) reasons.push('bytecode/implementação difere do registro canônico');
    if (asset.expectedMintAuthority !== undefined && (t.mintAuthority ?? null) !== (asset.expectedMintAuthority ?? null)) reasons.push('mint authority difere do registro canônico');
    if (t.hooks) reasons.push('token com hooks/extensões de transferência incompatíveis com o escrow');
    return { ok: reasons.length === 0, reasons, observed: { exists: true, decimals: t.decimals, symbol: t.symbol, codeHash: t.codeHash, mintAuthority: t.mintAuthority ?? null, standard: t.standard }, checkedAt };
  }
  async getBalance(address: string, asset: CanonicalAsset): Promise<bigint> { this.rpc(); return this.balanceOf(address, asset.contractOrMint); }
  async estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> { this.rpc(); const base: Record<Network, number> = { ethereum: 6.8, bitcoin: 4.2, solana: 0.01, zcash: 0.05 }; return (base[this.chain.network] * (op === 'settle' ? 1.5 : 1)).toFixed(2); }

  async registerDeal(c: DealCommitment): Promise<TxRef> {
    this.rpc(); const cur = this.deals.get(c.dealId);
    if (cur && cur.status !== 'SUPERSEDED' && cur.status !== 'REFUNDED' && cur.commit.revision === c.revision) throw new DomainError('SETTLEMENT_FAILED', 'dealId já registrado nesta revisão');
    // valida commitment: hash recomputado a partir do que o contrato guardará
    if (this.recomputeHash(c) !== c.dealHash) throw new DomainError('SETTLEMENT_FAILED', 'commitment inconsistente com dealHash');
    const legs = c.legs.filter(l => l.escrowChain === this.chain.network);
    const htlc = c.htlcHash && legs.some(l => l.mode === 'HTLC') ? { hash: c.htlcHash, timelock: c.expiresAt - 2 * 3600_000, locked: false } : undefined;
    this.deals.set(c.dealId, { commit: c, status: 'REGISTERED', deposits: {}, depositTx: {}, settledLegs: {}, usedNonces: new Set(), htlc });
    return this.tx();
  }
  private recomputeHash(c: DealCommitment): string {
    const parts = [...c.participants].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
    const participantsRoot = sha256Hex(parts.map(p => sha256Hex(canonicalize({ role: p.role, network: p.network, chainId: p.chainId, keyScheme: p.keyScheme, address: p.address }))).join(''));
    const legsRoot = sha256Hex([...c.legs].sort((a, b) => a.index - b.index).map(legHashOf).join(''));
    return sha256Hex([c.domainHash, c.dealId, String(c.revision), participantsRoot, legsRoot, c.pricingHash, c.routeHash, String(c.expiresAt), c.dealNonce].join('|'));
  }
  private legOf(d: StoredDeal, idx: number) { const leg = d.commit.legs.find(l => l.index === idx); if (!leg || leg.escrowChain !== this.chain.network) throw new DomainError('SETTLEMENT_FAILED', `leg ${idx} não pertence a ${this.chain.network}`); return leg; }
  private addrOf(d: StoredDeal, role: Role): string { const p = d.commit.participants.find(x => x.role === role); if (!p) throw new DomainError('SETTLEMENT_FAILED', 'papel ausente'); return p.address; }

  async deposit(dealId: string, legIndex: number, from: string): Promise<TxRef> {
    this.rpc(); const d = this.deals.get(dealId); if (!d) throw new DomainError('SETTLEMENT_FAILED', 'deal não registrada on-chain');
    if (d.status !== 'REGISTERED' && d.status !== 'FUNDED') throw new DomainError('SETTLEMENT_FAILED', `depósito não permitido em ${d.status}`);
    if (this.now() >= d.commit.expiresAt) throw new DomainError('DEAL_EXPIRED', 'deal expirada on-chain');
    const leg = this.legOf(d, legIndex); if (this.addrOf(d, leg.from) !== from) throw new DomainError('SETTLEMENT_FAILED', 'depositante não é a carteira da leg');
    if (d.deposits[legIndex]) return { chain: this.chain.network, ref: d.depositTx[legIndex] as string, submittedAt: this.now() }; // idempotente
    this.move(leg.asset.contractOrMint, from, this.escrow, BigInt(leg.amountBase));
    d.deposits[legIndex] = leg.amountBase; const t = this.tx(); d.depositTx[legIndex] = t.ref; if (d.htlc && leg.mode === 'HTLC') d.htlc.locked = true;
    const myLegs = d.commit.legs.filter(l => l.escrowChain === this.chain.network); if (myLegs.every(l => d.deposits[l.index])) d.status = 'FUNDED';
    return t;
  }

  /** settle(): recomputa hash, verifica N/N (uma por papel, signer == participante), expiração, status, nonces; efeito antes de transferir. */
  async settle(dealId: string, legIndex: number, signatures: ApprovalSignature[], preimage?: string): Promise<TxRef> {
    this.rpc(); const d = this.deals.get(dealId); if (!d) throw new DomainError('SETTLEMENT_FAILED', 'deal não registrada on-chain');
    if (d.status === 'SETTLED' || d.settledLegs[legIndex]) throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'leg já liquidada on-chain', { tx: d.settledLegs[legIndex] ?? d.settledTx });
    if (d.status !== 'FUNDED') throw new DomainError('SETTLEMENT_NOT_ALLOWED', `status on-chain ${d.status} não permite settle`);
    if (this.now() >= d.commit.expiresAt - 60_000) throw new DomainError('DEAL_EXPIRED', 'expirada (margem de execução) on-chain');
    const dealHash = this.recomputeHash(d.commit);
    const required = d.commit.participants.length; const seen = new Set<Role>();
    for (const s of signatures) {
      const p = d.commit.participants.find(x => x.role === s.role); if (!p || p.address !== s.signer || seen.has(s.role)) throw new DomainError('SIGNATURE_WRONG_SIGNER', `assinatura inválida para o papel ${s.role} on-chain`);
      if (d.usedNonces.has(s.nonce)) throw new DomainError('NONCE_INVALID', 'nonce já consumido on-chain');
      if (!(await this.verifier(dealHash, p, s))) throw new DomainError('SIGNATURE_INVALID', `assinatura criptográfica inválida on-chain (${s.role})`);
      seen.add(s.role);
    }
    if (seen.size !== required) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `assinaturas ${seen.size}/${required} — não liquida`);
    const leg = this.legOf(d, legIndex);
    if (leg.mode === 'HTLC' || d.htlc) { if (!preimage || !/^[0-9a-f]{64}$/.test(preimage) || sha256Hex(hexToBytes(preimage)) !== d.commit.htlcHash) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'preimage HTLC ausente ou inválida'); }
    if (this.faults.settleReverts) { this.tx(false, 'reverted'); throw new DomainError('SETTLEMENT_FAILED', 'transação revertida'); }
    signatures.forEach(s => d.usedNonces.add(s.nonce));
    // Como no contrato (§11.5): UMA transação liquida todas as legs locais da Deal atomicamente. Estado antes das interações.
    const t = this.tx(); if (preimage) d.preimage = preimage;
    const myLegs = d.commit.legs.filter(l => l.escrowChain === this.chain.network && !d.settledLegs[l.index]);
    for (const l of myLegs) d.settledLegs[l.index] = t.ref;
    d.status = 'SETTLED'; d.settledTx = t.ref;
    for (const l of myLegs) { const amount = BigInt(l.amountBase); const fee = l.from === 'BUYER' ? amount * BigInt(d.commit.feeBps) / 10000n : 0n; // fee só na leg de pagamento (ADR-005)
      this.move(l.asset.contractOrMint, this.escrow, this.addrOf(d, l.to), amount - fee); if (fee > 0n) this.move(l.asset.contractOrMint, this.escrow, d.commit.treasury, fee); }
    void leg;
    if (this.faults.reorgAfterSettle) { const st = this.txs.get(t.ref); if (st) { st.status = 'reverted'; st.error = 'reorg'; } }
    return t;
  }
  async refund(dealId: string, legIndex: number): Promise<TxRef> {
    this.rpc(); const d = this.deals.get(dealId); if (!d) throw new DomainError('SETTLEMENT_FAILED', 'deal não registrada on-chain');
    if (d.status === 'SETTLED') throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'não há reembolso após liquidação');
    const expired = this.now() >= d.commit.expiresAt; const superseded = d.status === 'SUPERSEDED';
    if (d.settledLegs[legIndex]) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'leg já liquidada');
    if (!expired && !superseded) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'reembolso só após expiração ou revisão superseded');
    const leg = this.legOf(d, legIndex); const dep = d.deposits[legIndex]; if (!dep) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'nada depositado nesta leg');
    this.move(leg.asset.contractOrMint, this.escrow, this.addrOf(d, leg.from), BigInt(dep)); delete d.deposits[legIndex];
    const t = this.tx(); d.refundedTx = t.ref; if (Object.keys(d.deposits).length === 0 && !superseded) d.status = 'REFUNDED'; return t;
  }
  async supersede(dealId: string, revision: number): Promise<TxRef | null> { this.rpc(); const d = this.deals.get(dealId); if (!d || d.commit.revision !== revision || d.status === 'SETTLED') return null; d.status = 'SUPERSEDED'; return this.tx(); }
  async getDealState(dealId: string): Promise<OnChainDealState> { this.rpc(); const d = this.deals.get(dealId); if (!d) return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} }; return { status: d.status, revision: d.commit.revision, deposits: { ...d.deposits }, settledLegs: { ...d.settledLegs }, settledTx: d.settledTx, refundedTx: d.refundedTx, dealHash: d.commit.dealHash }; }
  async waitFinal(ref: string): Promise<TxStatus> { this.rpc(); const s = this.txs.get(ref); if (!s) return { ref, status: 'pending', confirmations: 0 }; if (this.faults.slowFinality) return { ...s, status: 'included', confirmations: 1 }; return s; }
  async revealedPreimage(dealId: string): Promise<string | null> { this.rpc(); return this.deals.get(dealId)?.preimage ?? null; }
}

/** Fábrica dos três adaptadores locais com as capacidades da matriz §10.4 (verificador de assinaturas injetado). */
export function createLocalAdapters(verifier: ApprovalVerifier, now?: () => number): { evm: LocalChainAdapter; solana: LocalChainAdapter; bitcoin: LocalChainAdapter } {
  const evm = new LocalChainAdapter('ethereum', '31337', '0x000000000000000000000000000000000000e5c0', verifier, { finality: 2, nativeCode: 'ETH', htlc: false, escrowNN: true, verifiable: ['secp256k1'] });
  const solana = new LocalChainAdapter('solana', 'localnet', 'VerumEscrow11111111111111111111111111111111', verifier, { finality: 1, nativeCode: 'SOL', htlc: false, escrowNN: true, verifiable: ['ed25519', 'secp256k1'] });
  const bitcoin = new LocalChainAdapter('bitcoin', 'regtest', 'bcrt1qverumescrowhtlc00000000000000000000000', verifier, { finality: 3, nativeCode: 'BTC', htlc: true, escrowNN: false, verifiable: [] });
  if (now) { evm.now = now; solana.now = now; bitcoin.now = now; }
  return { evm, solana, bitcoin };
}
export { NETWORK_KEY_SCHEME };
