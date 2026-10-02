/**
 * Signature Engine — nonces, envelopes por esquema e verificação criptográfica.
 * EVM: EIP-712 (secp256k1, viem). Solana: Ed25519 sobre mensagem off-chain (tweetnacl). Bitcoin: BIP-137 (ECDSA, noble).
 * O envelope é SEMPRE reconstruído a partir dos termos persistidos — o cliente só devolve a assinatura.
 */
import { recoverTypedDataAddress, keccak256, encodeAbiParameters, stringToHex, type TypedDataDomain } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32 } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalize, randomHex, type Deal, type KeyScheme, type Role, type Environment, type Terms } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../db/repository.js';
import type { ApprovalSignature } from '../adapters/types.js';

export interface ApprovalPayload { domain: string; dealId: string; revision: number; role: Role; signer: string; network: string; chainId: string; nonce: string; expiresAt: number; dealHash: string; assetIn: string; amountIn: string; assetOut: string; amountOut: string; counterparty: string }
export interface Envelope { scheme: KeyScheme; network: string; payload: ApprovalPayload; message: string; typedData?: { domain: TypedDataDomain; types: typeof EIP712_TYPES; primaryType: 'DealApproval'; message: DealApprovalMessage } }

export const EIP712_TYPES = {
  DealApproval: [
    { name: 'dealHash', type: 'bytes32' }, { name: 'termsHash', type: 'bytes32' }, { name: 'dealId', type: 'string' }, { name: 'revision', type: 'uint32' }, { name: 'role', type: 'uint8' }, { name: 'signer', type: 'address' },
    { name: 'nonce', type: 'string' }, { name: 'expiresAt', type: 'uint64' }, { name: 'assetIn', type: 'string' }, { name: 'amountIn', type: 'uint256' }, { name: 'assetOut', type: 'string' }, { name: 'amountOut', type: 'uint256' }, { name: 'counterparty', type: 'string' }
  ]
} as const;
export interface DealApprovalMessage { dealHash: `0x${string}`; termsHash: `0x${string}`; dealId: string; revision: number; role: number; signer: `0x${string}`; nonce: string; expiresAt: bigint; assetIn: string; amountIn: bigint; assetOut: string; amountOut: bigint; counterparty: string }
const ROLE_CODE: Record<Role, number> = { SELLER: 0, BUYER: 1, PAYMASTER_1: 2, PAYMASTER_2: 3 };

/* ---------- Termos EVM (espelho exato de VerumOtcEscrow.RegisterInput / _termsHash) ---------- */
export type Hex = `0x${string}`;
export interface EvmDealTerms {
  dealId: string; revision: number; dealHash: Hex; expiresAtMs: bigint; participants: Hex[]; assetInHash: Hex; assetOutHash: Hex; amountIn: bigint; amountOut: bigint; minAmountOut: bigint; referencePrice: bigint;
  discountBps: number; feeBps: number; commissionBps: number; commissionSplitBps: [number, number]; commissionAmount: bigint; routeHash: Hex; dealNonce: Hex; htlcHash: Hex; counterpartyHash: Hex; sellerHash: Hex; termsHash: Hex;
}
export const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
/** Preço de referência inteiro com 8 casas (USD × 1e8), determinístico a partir da string decimal. */
export function referencePriceUnits(decimalStr: string): bigint { const [i, f = ''] = decimalStr.split('.'); return BigInt((i ?? '0') + (f + '00000000').slice(0, 8)); }
/** Comissão em unidades do ativo de saída: amountOut = usdIn·(1−d−c)/pOut ⇒ commission = amountOut·c/(1−d−c) (piso). */
export function commissionAmountOf(amountOut: bigint, discountBps: number, commissionBps: number): bigint { const rest = 10000 - discountBps - commissionBps; return rest <= 0 || commissionBps === 0 ? 0n : amountOut * BigInt(commissionBps) / BigInt(rest); }
/** termsHash = keccak(abi.encode(keccak(A), keccak(B))) — idêntico ao contrato. */
export function evmTermsHash(t: Omit<EvmDealTerms, 'termsHash'>, chainId: bigint, contract: Hex): Hex {
  const pm2 = t.participants[3] ?? ('0x' + '00'.repeat(20)) as Hex; const dealIdHash = keccak256(stringToHex(t.dealId));
  const a = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
    [dealIdHash, t.revision, chainId, contract, t.participants[0]!, t.participants[1]!, t.participants[2]!, pm2, t.assetInHash, t.assetOutHash, t.amountIn]));
  const b = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'uint8' }],
    [t.amountOut, t.minAmountOut, t.referencePrice, t.discountBps, t.feeBps, t.commissionBps, t.commissionSplitBps[0], t.commissionSplitBps[1], t.commissionAmount, t.routeHash, t.dealNonce, t.expiresAtMs, t.participants.length]));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [a, b]));
}
/** Deriva os termos EVM (RegisterInput + termsHash) dos termos congelados da Deal. Uma única função de verdade para backend, testes e keeper. */
export function evmDealTerms(t: Terms, dealHash: string, routeHash: string, chainId: bigint, contract: Hex): EvmDealTerms {
  const legIn = t.legs[0]; const legOut = t.legs[1]; if (!legIn || !legOut) throw new DomainError('INVALID_INPUT', 'legs incompletas');
  const parts = [...t.participants].sort((x, y) => ROLE_CODE[x.role] - ROLE_CODE[y.role]).map(p => p.address as Hex);
  const split: [number, number] = [t.pricing.commissionSplitBps[0] ?? t.pricing.commissionBps, t.pricing.commissionSplitBps[1] ?? 0];
  const base: Omit<EvmDealTerms, 'termsHash'> = {
    dealId: t.dealId, revision: t.revision, dealHash: ('0x' + dealHash) as Hex, expiresAtMs: BigInt(t.expiresAt), participants: parts,
    assetInHash: keccak256(stringToHex(legIn.asset.assetId)), assetOutHash: keccak256(stringToHex(legOut.asset.assetId)), amountIn: BigInt(legIn.amountBase), amountOut: BigInt(legOut.amountBase), minAmountOut: BigInt(legOut.amountBase),
    referencePrice: referencePriceUnits(t.pricing.referencePriceInUsd), discountBps: t.pricing.discountBps, feeBps: t.pricing.platformFeeBps, commissionBps: t.pricing.commissionBps, commissionSplitBps: split,
    commissionAmount: commissionAmountOf(BigInt(legOut.amountBase), t.pricing.discountBps, t.pricing.commissionBps), routeHash: ('0x' + routeHash) as Hex, dealNonce: keccak256(stringToHex(t.dealNonce)), htlcHash: t.route.htlcHash ? ('0x' + t.route.htlcHash) as Hex : ZERO32,
    counterpartyHash: keccak256(stringToHex(t.participants.find(x => x.role === 'BUYER')?.address ?? '')), sellerHash: keccak256(stringToHex(t.participants.find(x => x.role === 'SELLER')?.address ?? ''))
  };
  return { ...base, termsHash: evmTermsHash(base, chainId, contract) };
}

export function envelopeFor(deal: Deal, role: Role, nonce: string, env: Environment, escrowContractByChain: (network: string) => string): Envelope {
  const t = deal.terms; const h = deal.hash; if (!t || !h) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos não congelados');
  const p = t.participants.find(x => x.role === role); if (!p) throw new DomainError('NOT_PARTICIPANT', 'papel não existe na Deal');
  const legIn = t.legs[0]; const legOut = t.legs[1]; if (!legIn || !legOut) throw new DomainError('INVALID_INPUT', 'legs incompletas');
  const counterparty = t.participants.find(x => x.role === (role === 'SELLER' ? 'BUYER' : 'SELLER'))?.address ?? '';
  const payload: ApprovalPayload = { domain: `VerumOTC/1/${env}`, dealId: t.dealId, revision: t.revision, role, signer: p.address, network: p.network, chainId: p.chainId, nonce, expiresAt: t.expiresAt, dealHash: h.dealHash, assetIn: legIn.asset.assetId, amountIn: legIn.amountBase, assetOut: legOut.asset.assetId, amountOut: legOut.amountBase, counterparty };
  const message = `${payload.domain}\n${canonicalize(payload)}`;
  const envelope: Envelope = { scheme: p.keyScheme, network: p.network, payload, message };
  if (p.network === 'ethereum') {
    const contract = escrowContractByChain('ethereum') as Hex; const evm = evmDealTerms(t, h.dealHash, h.routeHash, BigInt(p.chainId), contract);
    envelope.typedData = { domain: { name: 'VerumOTC', version: '1', chainId: Number(p.chainId), verifyingContract: contract }, types: EIP712_TYPES, primaryType: 'DealApproval',
      message: { dealHash: ('0x' + h.dealHash) as `0x${string}`, termsHash: evm.termsHash, dealId: payload.dealId, revision: payload.revision, role: ROLE_CODE[role], signer: p.address as `0x${string}`, nonce, expiresAt: BigInt(payload.expiresAt), assetIn: payload.assetIn, amountIn: BigInt(payload.amountIn), assetOut: payload.assetOut, amountOut: BigInt(payload.amountOut), counterparty } };
  }
  return envelope;
}

/* ---------- verificação por esquema ---------- */
export async function verifyEvm(envelope: Envelope, signature: string, expected: string): Promise<boolean> {
  try { if (!envelope.typedData) return false; const addr = await recoverTypedDataAddress({ domain: envelope.typedData.domain, types: envelope.typedData.types, primaryType: 'DealApproval', message: envelope.typedData.message, signature: signature as `0x${string}` }); return addr.toLowerCase() === expected.toLowerCase(); } catch { return false; }
}
export function verifySolana(message: string, signatureB58: string, addressB58: string): boolean {
  try { return nacl.sign.detached.verify(utf8ToBytes(message), bs58.decode(signatureB58), bs58.decode(addressB58)); } catch { return false; }
}
/** BIP-137: assinatura base64 (65 bytes), mensagem com prefixo "Bitcoin Signed Message:\n". Suporta P2WPKH (bech32) e P2PKH. */
export function bitcoinMessageHash(message: string): Uint8Array {
  const prefix = utf8ToBytes('Bitcoin Signed Message:\n'); const msg = utf8ToBytes(message);
  const varint = (n: number): Uint8Array => n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8);
  const buf = new Uint8Array([...varint(prefix.length), ...prefix, ...varint(msg.length), ...msg]);
  return sha256(sha256(buf));
}
export function verifyBitcoin(message: string, signatureB64: string, address: string): boolean {
  try {
    const sig = Uint8Array.from(Buffer.from(signatureB64, 'base64')); if (sig.length !== 65) return false;
    const header = sig[0] as number; if (header < 27 || header > 42) return false; const recovery = (header - 27) & 3;
    const recovered = new Uint8Array([recovery, ...sig.slice(1)]); const pubUncompressed = secp256k1.recoverPublicKey(recovered, bitcoinMessageHash(message), { prehash: false }); const pub = secp256k1.Point.fromBytes(pubUncompressed).toBytes(true);
    const h160 = ripemd160(sha256(pub));
    if (/^(bc1|tb1|bcrt1)/.test(address)) { const dec = bech32.decode(address as `${string}1${string}`); const words = dec.words; if (words[0] !== 0) return false; const prog = bech32.fromWords(words.slice(1)); return Buffer.from(prog).equals(Buffer.from(h160)); }
    // P2PKH: comparação por hash160 codificado em base58check
    const version = address.startsWith('m') || address.startsWith('n') ? 0x6f : 0x00; const payload = new Uint8Array([version, ...h160]); const chk = sha256(sha256(payload)).slice(0, 4);
    return bs58.encode(new Uint8Array([...payload, ...chk])) === address;
  } catch { return false; }
}

/* ---------- Tron (TIP-191, equivalente ao signMessageV2 do TronWeb/TronLink) ---------- */
export function tronMessageHash(message: string): Uint8Array {
  const msg = utf8ToBytes(message);
  return keccak_256(new Uint8Array([...utf8ToBytes(`\x19TRON Signed Message:\n${msg.length}`), ...msg]));
}
/** Endereço T... = base58check(0x41 ‖ keccak256(pubkey)[12..]). */
export function tronAddressFromPubkey(pubUncompressed: Uint8Array): string {
  const h = keccak_256(pubUncompressed.slice(1)).slice(12);
  const payload = new Uint8Array([0x41, ...h]);
  const chk = sha256(sha256(payload)).slice(0, 4);
  return bs58.encode(new Uint8Array([...payload, ...chk]));
}
/** Assinatura hex 65 bytes (r‖s‖v, v∈{0,1,27,28}) sobre a mensagem TIP-191. */
export function verifyTron(message: string, signatureHex: string, addressT: string): boolean {
  try {
    const raw = Uint8Array.from(Buffer.from(signatureHex.replace(/^0x/, ''), 'hex'));
    if (raw.length !== 65) return false;
    let v = raw[64] as number; if (v >= 27) v -= 27; if (v > 3) return false;
    const recovered = new Uint8Array([v, ...raw.slice(0, 64)]);
    const pub = secp256k1.recoverPublicKey(recovered, tronMessageHash(message), { prehash: false });
    return tronAddressFromPubkey(secp256k1.Point.fromBytes(pub).toBytes(false)) === addressT;
  } catch { return false; }
}

export class SignatureEngine {
  constructor(private readonly store: Store, private readonly env: Environment, private readonly escrowByChain: (network: string) => string, private readonly now: () => number = () => Date.now()) {}

  async issueNonce(kind: 'challenge' | 'approval', ttlMs: number, ctx?: { dealId: string; revision: number; role: Role; subject?: string }): Promise<string> {
    if (ctx) { const open = await this.store.findOpenNonce(ctx.dealId, ctx.revision, ctx.role, this.now()); if (open) return open.value; } // reutiliza o nonce aberto: sem crescimento por GET repetido
    const value = randomHex(16); await this.store.insertNonce({ value, kind, dealId: ctx?.dealId ?? null, revision: ctx?.revision ?? null, role: ctx?.role ?? null, subject: ctx?.subject ?? null, issuedAt: this.now(), expiresAt: this.now() + ttlMs, consumedAt: null }); return value;
  }
  async envelope(deal: Deal, role: Role): Promise<Envelope> {
    if (!deal.terms) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos não congelados');
    const nonce = await this.issueNonce('approval', Math.max(1000, deal.terms.expiresAt - this.now()), { dealId: deal.id, revision: deal.revision, role });
    return envelopeFor(deal, role, nonce, this.env, this.escrowByChain);
  }
  /** Verificação criptográfica pura (também injetada nos simuladores como "on-chain"). Reconstrói o envelope pelos termos. */
  async verifyAgainstDeal(deal: Deal, sig: ApprovalSignature): Promise<{ ok: boolean; reason?: string; envelope?: Envelope }> {
    const p = deal.terms?.participants.find(x => x.role === sig.role);
    if (!p) return { ok: false, reason: 'papel inexistente' };
    if (p.address.toLowerCase() !== sig.signer.toLowerCase()) return { ok: false, reason: 'signatário não é a carteira do papel' };
    if (p.keyScheme !== sig.scheme) return { ok: false, reason: 'esquema de chave incompatível' };
    const envelope = envelopeFor(deal, sig.role, sig.nonce, this.env, this.escrowByChain);
    const ok = p.network === 'ethereum' ? await verifyEvm(envelope, sig.signature, p.address) : p.network === 'solana' ? verifySolana(envelope.message, sig.signature, p.address) : p.network === 'tron' ? verifyTron(envelope.message, sig.signature, p.address) : verifyBitcoin(envelope.message, sig.signature, p.address);
    return ok ? { ok, envelope } : { ok: false, reason: 'assinatura criptográfica inválida', envelope };
  }
  /** Regras RAS-020: estado, expiração, nonce emitido para (deal, revisão, papel) e não consumido, verificação criptográfica. */
  async validateApproval(deal: Deal, sig: ApprovalSignature): Promise<Envelope> {
    if (deal.state !== 'AWAITING_SIGNATURES') throw new DomainError('SETTLEMENT_NOT_ALLOWED', `Deal em ${deal.state} não aceita assinaturas`);
    if (!deal.terms) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos não congelados');
    if (this.now() >= deal.terms.expiresAt) throw new DomainError('DEAL_EXPIRED', 'Deal expirada — assinatura rejeitada');
    const n = await this.store.getNonce(sig.nonce);
    if (!n || n.kind !== 'approval' || n.dealId !== deal.id || n.revision !== deal.revision || n.role !== sig.role) throw new DomainError('NONCE_INVALID', 'nonce não corresponde a esta Deal/revisão/papel');
    if (n.consumedAt !== null) throw new DomainError('NONCE_INVALID', 'nonce já utilizado');
    if (this.now() >= n.expiresAt) throw new DomainError('SIGNATURE_EXPIRED', 'nonce expirado');
    const r = await this.verifyAgainstDeal(deal, sig);
    if (!r.ok || !r.envelope) throw new DomainError(r.reason?.includes('signatário') ? 'SIGNATURE_WRONG_SIGNER' : 'SIGNATURE_INVALID', r.reason ?? 'assinatura inválida');
    return r.envelope;
  }
}

/* ---------- ajudantes de assinatura para testes/dev (chaves geradas em memória, nunca persistidas) ---------- */
export const testSigning = {
  solana(): { address: string; sign: (message: string) => string } { const kp = nacl.sign.keyPair(); return { address: bs58.encode(kp.publicKey), sign: m => bs58.encode(nacl.sign.detached(utf8ToBytes(m), kp.secretKey)) }; },
  bitcoin(hrp: 'bc' | 'bcrt' | 'tb' = 'bcrt'): { address: string; sign: (message: string) => string } {
    const priv = secp256k1.utils.randomSecretKey(); const pub = secp256k1.getPublicKey(priv, true); const h160 = ripemd160(sha256(pub)); const address = bech32.encode(hrp, [0, ...bech32.toWords(h160)]);
    return { address, sign: m => { const s = secp256k1.sign(bitcoinMessageHash(m), priv, { prehash: false, format: 'recovered' }); const header = 27 + (s[0] as number) + 4; return Buffer.from(new Uint8Array([header, ...s.slice(1)])).toString('base64'); } };
  },
  tron(): { address: string; sign: (message: string) => string } {
    const priv = secp256k1.utils.randomSecretKey(); const pub = secp256k1.getPublicKey(priv, false);
    const address = tronAddressFromPubkey(pub);
    return { address, sign: m => { const s = secp256k1.sign(tronMessageHash(m), priv, { prehash: false, format: 'recovered' }); return '0x' + Buffer.from(new Uint8Array([...s.slice(1), (s[0] as number) + 27])).toString('hex'); } };
  }
};
