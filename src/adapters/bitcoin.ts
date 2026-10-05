/**
 * BitcoinChainAdapter — adapter REAL da rede Bitcoin (substitui o simulador regtest).
 * A leg BTC nativa vive num HTLC P2WSH com o script de referência do ADR-v4:
 *
 *   OP_IF
 *     OP_SHA256 <hash> OP_EQUALVERIFY <pubkey_claim> OP_CHECKSIG        # claim com a preimage
 *   OP_ELSE
 *     <csv> OP_CHECKSEQUENCEVERIFY OP_DROP <pubkey_refund> OP_CHECKSIG  # refund após ~24h (144 blocos)
 *   OP_ENDIF
 *
 * Constrói, assina (BIP-143, @noble/curves) e transmite transações P2WSH via Esplora
 * (blockstream.info/mempool.space/regtest local — BITCOIN_ESPLORA_URL). `revealedPreimage()`
 * observa o GASTO do outpoint do HTLC na rede e extrai a preimage real do witness — é ela que
 * fecha o swap atômico com a perna de contrato (escrow EVM/Tron/Solana com o mesmo sha256).
 *
 * Custódia das chaves do script: o hashlock on-chain garante a atomicidade (ninguém move o BTC
 * sem a preimage antes do timelock); as chaves claim/refund são do keeper da plataforma — o
 * claim PAGA ao endereço BTC do comprador e o refund PAGA ao do vendedor. Quando a Verum Wallet
 * expuser as pubkeys dos participantes (recuperáveis da assinatura BIP-137 do join), os campos
 * entram no script no lugar das chaves do keeper (TODO rastreado no ADR-v4 §2).
 *
 * Determinismo serverless: o script é reconstruível só com htlcHash + chaves do keeper + CSV —
 * nenhum estado local é obrigatório; o cache em memória é só atalho e `deps.getDeal` reidrata.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';
import bs58 from 'bs58';
import { DomainError } from '../domain/errors.js';
import type { CanonicalAsset, ChainRef, Deal, Leg, Participant, Terms } from '../domain/types.js';
import type { AdapterCapabilities, ApprovalSignature, AssetVerification, DealCommitment, OnChainDealState, RegisterResult, SettlementAdapter, TxRef, TxStatus } from './types.js';

export type BitcoinNet = 'mainnet' | 'testnet' | 'regtest';
export interface BitcoinSettings {
  esploraUrl: string; network: BitcoinNet;
  claimKey: string; refundKey: string;            // hex 32 bytes (keeper)
  confirmations: number; csvBlocks: number; feeFloorSatVb: number;
}

const HRP: Record<BitcoinNet, string> = { mainnet: 'bc', testnet: 'tb', regtest: 'bcrt' };
const dsha256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));
const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b));

/* ---------------- primitivas de serialização Bitcoin ---------------- */

const u32le = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
export function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return concatBytes(Uint8Array.of(0xfe), u32le(n));
}
const pushData = (b: Uint8Array): Uint8Array => {
  if (b.length <= 75) return concatBytes(Uint8Array.of(b.length), b);
  if (b.length <= 255) return concatBytes(Uint8Array.of(0x4c, b.length), b);
  throw new DomainError('INVALID_INPUT', 'push de script acima do suportado');
};
/** Número de script (CScriptNum) minimal — suficiente para o CSV de blocos (1..65535). */
export function scriptNum(n: number): Uint8Array {
  if (n < 1 || n > 0xffff || !Number.isInteger(n)) throw new DomainError('INVALID_INPUT', 'CSV fora do intervalo');
  const out: number[] = [];
  let v = n;
  while (v > 0) { out.push(v & 0xff); v >>= 8; }
  if ((out[out.length - 1] as number) & 0x80) out.push(0); // evita interpretação como negativo
  return Uint8Array.from(out);
}

/* ---------------- script HTLC + endereço P2WSH ---------------- */

const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, DUP: 0x76, EQUAL: 0x87, EQUALVERIFY: 0x88, SHA256: 0xa8, HASH160: 0xa9, CHECKSIG: 0xac, CSV: 0xb2, ZERO: 0x00 } as const;

/** Witness script do HTLC — exatamente o layout do ADR-v4 §2. */
export function htlcWitnessScript(htlcHashHex: string, claimPub: Uint8Array, refundPub: Uint8Array, csvBlocks: number): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(htlcHashHex)) throw new DomainError('INVALID_INPUT', 'htlcHash inválido (sha256 hex de 32 bytes)');
  if (claimPub.length !== 33 || refundPub.length !== 33) throw new DomainError('INVALID_INPUT', 'pubkeys do HTLC devem ser comprimidas (33 bytes)');
  return concatBytes(
    Uint8Array.of(OP.IF, OP.SHA256), pushData(hexToBytes(htlcHashHex)), Uint8Array.of(OP.EQUALVERIFY), pushData(claimPub), Uint8Array.of(OP.CHECKSIG),
    Uint8Array.of(OP.ELSE), pushData(scriptNum(csvBlocks)), Uint8Array.of(OP.CSV, OP.DROP), pushData(refundPub), Uint8Array.of(OP.CHECKSIG),
    Uint8Array.of(OP.ENDIF),
  );
}

export function p2wshAddress(witnessScript: Uint8Array, net: BitcoinNet): string {
  return bech32.encode(HRP[net], [0, ...bech32.toWords(sha256(witnessScript))], 120);
}
export function p2wpkhAddress(pub: Uint8Array, net: BitcoinNet): string {
  return bech32.encode(HRP[net], [0, ...bech32.toWords(hash160(pub))], 90);
}

/** scriptPubKey de um endereço de destino (bech32 v0 ou base58 legado) — para montar o output do payout. */
export function outputScriptOf(address: string, net: BitcoinNet): Uint8Array {
  const hrp = HRP[net];
  if (address.toLowerCase().startsWith(hrp + '1')) {
    const dec = bech32.decode(address.toLowerCase() as `${string}1${string}`, 120);
    if (dec.prefix !== hrp) throw new DomainError('WALLET_INVALID', `endereço de outra rede Bitcoin (${dec.prefix})`);
    const ver = dec.words[0] as number;
    const prog = bech32.fromWords(dec.words.slice(1));
    if (ver !== 0 || (prog.length !== 20 && prog.length !== 32)) throw new DomainError('WALLET_INVALID', 'endereço segwit não suportado (apenas v0 P2WPKH/P2WSH)');
    return concatBytes(Uint8Array.of(OP.ZERO), pushData(Uint8Array.from(prog)));
  }
  const raw = bs58.decode(address);
  if (raw.length !== 25) throw new DomainError('WALLET_INVALID', 'endereço base58 inválido');
  const payload = raw.slice(0, 21); const check = raw.slice(21);
  const want = dsha256(payload).slice(0, 4);
  if (bytesToHex(Uint8Array.from(check)) !== bytesToHex(want)) throw new DomainError('WALLET_INVALID', 'checksum do endereço base58 inválido');
  const version = payload[0] as number; const h = Uint8Array.from(payload.slice(1));
  const p2pkh = net === 'mainnet' ? 0x00 : 0x6f; const p2sh = net === 'mainnet' ? 0x05 : 0xc4;
  if (version === p2pkh) return concatBytes(Uint8Array.of(OP.DUP, OP.HASH160), pushData(h), Uint8Array.of(OP.EQUALVERIFY, OP.CHECKSIG));
  if (version === p2sh) return concatBytes(Uint8Array.of(OP.HASH160), pushData(h), Uint8Array.of(OP.EQUAL));
  throw new DomainError('WALLET_INVALID', 'versão de endereço base58 desconhecida para esta rede');
}

/* ---------------- transação segwit: build + BIP-143 + assinatura ---------------- */

export interface HtlcUtxo { txid: string; vout: number; valueSat: bigint; confirmations: number }
interface SpendPlan { utxos: HtlcUtxo[]; witnessScript: Uint8Array; payoutScript: Uint8Array; satPerVb: number; path: 'claim' | 'refund'; preimage?: string; keyPriv: Uint8Array; csvBlocks: number }

const outpoint = (u: HtlcUtxo): Uint8Array => concatBytes(hexToBytes(u.txid).reverse(), u32le(u.vout));

/**
 * sighash BIP-143 (SIGHASH_ALL) do input `idx` gastando P2WSH com `witnessScript`.
 * `outputs` = concatenação dos outputs serializados (valor + script) SEM o varint de contagem —
 * o hashOutputs da spec NÃO inclui a contagem (um nó real rejeita com NULLFAIL se incluir).
 */
export function bip143Sighash(plan: Pick<SpendPlan, 'utxos' | 'witnessScript'>, idx: number, sequence: number, outputs: Uint8Array): Uint8Array {
  const hashPrevouts = dsha256(concatBytes(...plan.utxos.map(outpoint)));
  const hashSequence = dsha256(concatBytes(...plan.utxos.map(() => u32le(sequence))));
  const hashOutputs = dsha256(outputs);
  const u = plan.utxos[idx] as HtlcUtxo;
  const scriptCode = concatBytes(varint(plan.witnessScript.length), plan.witnessScript);
  return dsha256(concatBytes(u32le(2), hashPrevouts, hashSequence, outpoint(u), scriptCode, u64le(u.valueSat), u32le(sequence), hashOutputs, u32le(0), u32le(1)));
}

/**
 * Monta e assina o gasto do HTLC (claim com preimage OU refund pós-CSV), consolidando todos os
 * UTXOs do endereço num único output de payout. Devolve hex pronto para broadcast + txid.
 */
export function buildHtlcSpend(plan: SpendPlan): { hex: string; txid: string; vsize: number; feeSat: bigint } {
  if (!plan.utxos.length) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'HTLC sem UTXO para gastar');
  const total = plan.utxos.reduce((s, u) => s + u.valueSat, 0n);
  const sequence = plan.path === 'refund' ? plan.csvBlocks : 0xfffffffd;
  const witnessOf = (sig: Uint8Array): Uint8Array[] => plan.path === 'claim'
    ? [sig, hexToBytes(plan.preimage as string), Uint8Array.of(0x01), plan.witnessScript]
    : [sig, new Uint8Array(0), plan.witnessScript];
  // Corpo dos outputs SEM varint de contagem: é o que o hashOutputs do BIP-143 cobre.
  const outputsFor = (value: bigint): Uint8Array => concatBytes(u64le(value), varint(plan.payoutScript.length), plan.payoutScript);
  // 1ª passada com assinatura dummy (72 bytes DER máx) só para medir o vsize e fixar a fee.
  const dummy = new Uint8Array(72);
  const draft = assemble(plan, outputsFor(total), plan.utxos.map(() => witnessOf(dummy)), sequence);
  const vsize = Math.ceil((3 * draft.noWitness.length + draft.withWitness.length) / 4);
  const feeSat = BigInt(Math.ceil(vsize * plan.satPerVb));
  const value = total - feeSat;
  if (value < 546n) throw new DomainError('SETTLEMENT_FAILED', 'valor do HTLC não cobre a taxa de rede (dust)', { totalSat: total.toString(), feeSat: feeSat.toString() });
  const outputs = outputsFor(value);
  const witnesses = plan.utxos.map((_, i) => {
    const sighash = bip143Sighash(plan, i, sequence, outputs);
    const der = secp256k1.sign(sighash, plan.keyPriv, { prehash: false, format: 'der' });
    return witnessOf(concatBytes(der, Uint8Array.of(0x01))); // SIGHASH_ALL
  });
  const finalTx = assemble(plan, outputs, witnesses, sequence);
  return { hex: bytesToHex(finalTx.withWitness), txid: bytesToHex(dsha256(finalTx.noWitness).reverse()), vsize, feeSat };
}

function assemble(plan: SpendPlan, outputs: Uint8Array, witnesses: Uint8Array[][], sequence: number): { withWitness: Uint8Array; noWitness: Uint8Array } {
  const ins = concatBytes(varint(plan.utxos.length), ...plan.utxos.map(u => concatBytes(outpoint(u), varint(0), u32le(sequence))));
  const core = concatBytes(ins, varint(1), outputs); // contagem de outputs só na serialização (nunca no sighash)
  const wit = concatBytes(...witnesses.map(items => concatBytes(varint(items.length), ...items.map(i => concatBytes(varint(i.length), i)))));
  return { withWitness: concatBytes(u32le(2), Uint8Array.of(0x00, 0x01), core, wit, u32le(0)), noWitness: concatBytes(u32le(2), core, u32le(0)) };
}

/** Extrai a preimage do witness de um gasto do HTLC (item de 32 bytes cujo sha256 == htlcHash). */
export function preimageFromWitness(witness: string[], htlcHashHex: string): string | null {
  for (const item of witness) {
    if (!/^[0-9a-f]{64}$/i.test(item)) continue;
    if (bytesToHex(sha256(hexToBytes(item))) === htlcHashHex.toLowerCase()) return item.toLowerCase();
  }
  return null;
}

/* ---------------- cliente Esplora ---------------- */

interface EsploraUtxo { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }
interface EsploraTx { txid: string; status: { confirmed: boolean; block_height?: number }; vin: { txid: string; vout: number; witness?: string[] }[]; vout: { scriptpubkey_address?: string; value: number }[] }

export class EsploraClient {
  constructor(private readonly base: string) {}
  private url(p: string): string { return this.base.replace(/\/$/, '') + p; }
  private async get<T>(p: string): Promise<T> {
    const r = await fetch(this.url(p)).catch((e: Error) => { throw new DomainError('ADAPTER_UNAVAILABLE', `Esplora indisponível: ${e.message}`); });
    if (r.status === 404) throw new DomainError('ADAPTER_UNAVAILABLE', `Esplora 404 em ${p}`);
    if (!r.ok) throw new DomainError('ADAPTER_UNAVAILABLE', `Esplora HTTP ${r.status} em ${p}`);
    return r.json() as Promise<T>;
  }
  async tipHeight(): Promise<number> { const r = await fetch(this.url('/blocks/tip/height')).catch((e: Error) => { throw new DomainError('ADAPTER_UNAVAILABLE', `Esplora indisponível: ${e.message}`); }); return Number(await r.text()); }
  async utxos(address: string): Promise<EsploraUtxo[]> { return this.get(`/address/${encodeURIComponent(address)}/utxo`); }
  async addressSats(address: string): Promise<bigint> {
    const j = await this.get<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { funded_txo_sum: number; spent_txo_sum: number } }>(`/address/${encodeURIComponent(address)}`);
    return BigInt(j.chain_stats.funded_txo_sum + j.mempool_stats.funded_txo_sum) - BigInt(j.chain_stats.spent_txo_sum + j.mempool_stats.spent_txo_sum);
  }
  async tx(txid: string): Promise<EsploraTx | null> { try { return await this.get(`/tx/${txid}`); } catch { return null; } }
  async outspend(txid: string, vout: number): Promise<{ spent: boolean; txid?: string }> { return this.get(`/tx/${txid}/outspend/${vout}`); }
  async addressTxs(address: string): Promise<EsploraTx[]> { return this.get(`/address/${encodeURIComponent(address)}/txs`); }
  async feeEstimates(): Promise<Record<string, number>> { try { return await this.get('/fee-estimates'); } catch { return {}; } }
  async broadcast(hex: string): Promise<string> {
    const r = await fetch(this.url('/tx'), { method: 'POST', body: hex }).catch((e: Error) => { throw new DomainError('ADAPTER_UNAVAILABLE', `Esplora indisponível: ${e.message}`); });
    const body = await r.text();
    if (!r.ok) throw new DomainError('SETTLEMENT_FAILED', `broadcast Bitcoin rejeitado: ${body.slice(0, 200)}`);
    return body.trim();
  }
}

/* ---------------- o adapter ---------------- */

interface HtlcEssentials { htlcHash: string; address: string; witnessScript: Uint8Array; leg: Leg; participants: Participant[]; expiresAt: number; revision: number; dealHash?: string }
export interface BitcoinAdapterDeps {
  getDeal: (id: string) => Promise<Deal | null>;
  /**
   * Endereço BTC de payout quando o participante do papel NÃO está na rede bitcoin na deal
   * (ex.: comprador conectado via Solana). Na mesa real vem dos endereços multichain da
   * Verum Wallet conectada à cadeira (wallet.addresses → network 'bitcoin').
   */
  btcAddressOf?: (dealId: string, role: Leg['from']) => Promise<string | null>;
}

export class BitcoinChainAdapter implements SettlementAdapter {
  readonly chain: ChainRef;
  private readonly esplora: EsploraClient;
  private readonly claimPriv: Uint8Array; private readonly claimPub: Uint8Array;
  private readonly refundPriv: Uint8Array; private readonly refundPub: Uint8Array;
  private readonly cache = new Map<string, HtlcEssentials>();
  now: () => number = () => Date.now();

  constructor(private readonly cfg: BitcoinSettings, private readonly deps?: BitcoinAdapterDeps) {
    this.chain = { network: 'bitcoin', chainId: cfg.network };
    this.esplora = new EsploraClient(cfg.esploraUrl);
    this.claimPriv = hexToBytes(cfg.claimKey.replace(/^0x/, ''));
    this.refundPriv = hexToBytes(cfg.refundKey.replace(/^0x/, ''));
    this.claimPub = secp256k1.getPublicKey(this.claimPriv, true);
    this.refundPub = secp256k1.getPublicKey(this.refundPriv, true);
  }

  capabilities(): AdapterCapabilities { return { escrowNN: false, htlc: true, verifiableSigSchemes: [], finalityConfirmations: this.cfg.confirmations, nativeCode: 'BTC' }; }
  /** Não há escrow global — o "cofre" visível é o endereço operacional do keeper (cada deal tem seu P2WSH). */
  escrowAddress(): string { return p2wpkhAddress(this.claimPub, this.cfg.network); }
  validateAddress(address: string): boolean { try { outputScriptOf(address, this.cfg.network); return true; } catch { return false; } }

  async verifyAsset(asset: CanonicalAsset): Promise<AssetVerification> {
    const checkedAt = this.now(); const reasons: string[] = [];
    if (asset.network !== 'bitcoin' || asset.chainId !== this.chain.chainId) reasons.push('rede/chainId não corresponde ao adaptador Bitcoin');
    if (asset.contractOrMint !== null || asset.tokenStandard !== 'native' || asset.code !== 'BTC') reasons.push('a rede Bitcoin só liquida BTC nativo (sem contrato)');
    if (asset.decimals !== 8) reasons.push('BTC tem 8 decimais (satoshi)');
    return { ok: reasons.length === 0, reasons, observed: { exists: reasons.length === 0, standard: 'native', decimals: 8, symbol: 'BTC' }, checkedAt };
  }

  async getBalance(address: string, asset: CanonicalAsset): Promise<bigint> {
    if (asset.contractOrMint !== null) return 0n;
    return this.esplora.addressSats(address);
  }

  async estimateCostUsd(op: 'deposit' | 'register' | 'settle' | 'refund'): Promise<string> {
    if (op === 'register') return '0.00'; // o registro BTC é off-chain (endereço derivado); só o funding/claim pagam fee
    const sats = BigInt(Math.ceil(160 * (await this.satPerVb())));
    const price = await this.btcUsd();
    return price == null ? '5.00' : ((Number(sats) / 1e8) * price).toFixed(2);
  }
  private async satPerVb(): Promise<number> {
    const est = await this.esplora.feeEstimates();
    const v = est['3'] ?? est['6'] ?? est['2'];
    return Math.max(this.cfg.feeFloorSatVb, v ? Math.ceil(v) : this.cfg.feeFloorSatVb);
  }
  private async btcUsd(): Promise<number | null> {
    try { const { getPricesById } = await import('../chains/prices.js'); const byId = await getPricesById(); return byId['bitcoin']?.usd ?? null; } catch { return null; }
  }

  /* ---- ciclo de vida do HTLC ---- */

  private essentialsFrom(htlcHash: string, legs: Leg[], participants: Participant[], expiresAt: number, revision: number, dealHash?: string): HtlcEssentials {
    const leg = legs.find(l => l.escrowChain === 'bitcoin');
    if (!leg) throw new DomainError('SETTLEMENT_FAILED', 'deal sem leg Bitcoin');
    if (!/^[0-9a-f]{64}$/.test(htlcHash)) throw new DomainError('SETTLEMENT_FAILED', 'deal Bitcoin sem htlcHash — rota HTLC é obrigatória');
    const witnessScript = htlcWitnessScript(htlcHash, this.claimPub, this.refundPub, this.cfg.csvBlocks);
    return { htlcHash, address: p2wshAddress(witnessScript, this.cfg.network), witnessScript, leg, participants, expiresAt, revision, dealHash };
  }
  private async hydrate(dealId: string): Promise<HtlcEssentials> {
    const hit = this.cache.get(dealId);
    if (hit) return hit;
    const deal = await this.deps?.getDeal(dealId);
    const t = deal?.terms as Terms | undefined;
    if (!deal || !t?.route.htlcHash) throw new DomainError('SETTLEMENT_FAILED', 'deal não registrada no adaptador Bitcoin');
    const e = this.essentialsFrom(t.route.htlcHash, t.legs, t.participants, t.expiresAt, deal.revision, deal.hash?.dealHash);
    this.cache.set(dealId, e);
    return e;
  }
  /** Endereço BTC de payout do papel: participante na rede bitcoin OU resolvedor multichain (Verum Wallet). */
  private async payoutOf(dealId: string, e: HtlcEssentials, role: Leg['from']): Promise<string> {
    const p = e.participants.find(x => x.role === role && x.network === 'bitcoin');
    const addr = p?.address ?? (await this.deps?.btcAddressOf?.(dealId, role)) ?? null;
    if (!addr) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `payout BTC impossível: o papel ${role} não tem endereço Bitcoin na deal nem na carteira multichain`);
    outputScriptOf(addr, this.cfg.network); // valida já aqui com motivo nominal
    return addr;
  }
  private async htlcUtxos(e: HtlcEssentials): Promise<HtlcUtxo[]> {
    const [utxos, tip] = await Promise.all([this.esplora.utxos(e.address), this.esplora.tipHeight()]);
    return utxos.map(u => ({ txid: u.txid, vout: u.vout, valueSat: BigInt(u.value), confirmations: u.status.confirmed && u.status.block_height ? tip - u.status.block_height + 1 : 0 }));
  }

  async registerDeal(c: DealCommitment): Promise<RegisterResult> {
    const e = this.essentialsFrom(c.htlcHash ?? '', c.legs, c.participants, c.expiresAt, c.revision, c.dealHash);
    this.cache.set(c.dealId, e);
    // Nenhuma transação é emitida aqui: o "registro" BTC é a derivação determinística do cofre
    // P2WSH; o funding (lock) é do lado vendedor via Verum Wallet. Meta persiste em deal.onChain.
    return { chain: 'bitcoin', ref: `htlc:${e.address}`, submittedAt: this.now(), meta: { htlcAddress: e.address, htlcHash: e.htlcHash, csvBlocks: this.cfg.csvBlocks, witnessScript: bytesToHex(e.witnessScript), network: this.cfg.network } };
  }

  /** O lock é feito pela carteira do vendedor; aqui DETECTAMOS o funding on-chain (idempotente). */
  async deposit(dealId: string, legIndex: number, _from: string): Promise<TxRef> {
    const e = await this.hydrate(dealId);
    if (e.leg.index !== legIndex) throw new DomainError('SETTLEMENT_FAILED', `leg ${legIndex} não pertence à rede Bitcoin`);
    if (this.now() >= e.expiresAt) throw new DomainError('DEAL_EXPIRED', 'deal expirada — não aceite novos locks BTC');
    const utxos = await this.htlcUtxos(e);
    const total = utxos.reduce((s, u) => s + u.valueSat, 0n);
    const required = BigInt(e.leg.amountBase);
    if (total < required) {
      throw new DomainError('FUNDING_REQUIRED', `HTLC ainda não financiado: envie ${e.leg.amountBase} sats para ${e.address}`, { address: e.address, requiredSat: e.leg.amountBase, seenSat: total.toString() });
    }
    const confirmed = utxos.filter(u => u.confirmations >= this.cfg.confirmations);
    if (confirmed.reduce((s, u) => s + u.valueSat, 0n) < required) {
      throw new DomainError('FUNDING_REQUIRED', `lock BTC visto no mempool — aguardando ${this.cfg.confirmations} confirmações`, { address: e.address });
    }
    return { chain: 'bitcoin', ref: (confirmed[0] as HtlcUtxo).txid, submittedAt: this.now() };
  }

  /** Claim do BTC com a preimage (revelada pelo settle da perna de contrato). Assinaturas da mesa não entram no script — o hashlock é a autorização. */
  async settle(dealId: string, legIndex: number, _signatures: ApprovalSignature[], preimage?: string): Promise<TxRef> {
    const e = await this.hydrate(dealId);
    if (e.leg.index !== legIndex) throw new DomainError('SETTLEMENT_FAILED', `leg ${legIndex} não pertence à rede Bitcoin`);
    if (!preimage || !/^[0-9a-f]{64}$/.test(preimage) || bytesToHex(sha256(hexToBytes(preimage))) !== e.htlcHash) {
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'preimage HTLC ausente ou inválida');
    }
    const prior = await this.spendOf(e);
    if (prior) {
      if (prior.preimage) return { chain: 'bitcoin', ref: prior.txid, submittedAt: this.now() }; // claim idempotente
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'HTLC já foi reembolsado ao vendedor (timelock vencido)', { tx: prior.txid });
    }
    const utxos = await this.htlcUtxos(e);
    if (!utxos.length) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'HTLC sem fundos para claim');
    const payout = await this.payoutOf(dealId, e, e.leg.to);
    const built = buildHtlcSpend({ utxos, witnessScript: e.witnessScript, payoutScript: outputScriptOf(payout, this.cfg.network), satPerVb: await this.satPerVb(), path: 'claim', preimage, keyPriv: this.claimPriv, csvBlocks: this.cfg.csvBlocks });
    const txid = await this.esplora.broadcast(built.hex);
    return { chain: 'bitcoin', ref: txid, submittedAt: this.now() };
  }

  /** Refund ao vendedor — só depois de `csvBlocks` confirmações do lock (OP_CHECKSEQUENCEVERIFY). */
  async refund(dealId: string, legIndex: number): Promise<TxRef> {
    const e = await this.hydrate(dealId);
    if (e.leg.index !== legIndex) throw new DomainError('SETTLEMENT_FAILED', `leg ${legIndex} não pertence à rede Bitcoin`);
    const prior = await this.spendOf(e);
    if (prior) {
      if (!prior.preimage) return { chain: 'bitcoin', ref: prior.txid, submittedAt: this.now() }; // refund idempotente
      throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'HTLC já foi liquidado via claim — nada a reembolsar', { tx: prior.txid });
    }
    const utxos = (await this.htlcUtxos(e)).filter(u => u.valueSat > 0n);
    if (!utxos.length) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'nada depositado no HTLC');
    const immature = utxos.filter(u => u.confirmations < this.cfg.csvBlocks);
    if (immature.length) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `timelock ainda não venceu: faltam ${this.cfg.csvBlocks - Math.min(...immature.map(u => u.confirmations))} blocos`, { csvBlocks: this.cfg.csvBlocks });
    const payout = await this.payoutOf(dealId, e, e.leg.from);
    const built = buildHtlcSpend({ utxos, witnessScript: e.witnessScript, payoutScript: outputScriptOf(payout, this.cfg.network), satPerVb: await this.satPerVb(), path: 'refund', keyPriv: this.refundPriv, csvBlocks: this.cfg.csvBlocks });
    const txid = await this.esplora.broadcast(built.hex);
    return { chain: 'bitcoin', ref: txid, submittedAt: this.now() };
  }

  async supersede(_dealId: string, _revision: number): Promise<TxRef | null> { return null; } // nada on-chain a supersedir (o HTLC é por htlcHash)

  async getDealState(dealId: string): Promise<OnChainDealState> {
    let e: HtlcEssentials;
    try { e = await this.hydrate(dealId); } catch { return { status: 'NONE', revision: 0, deposits: {}, settledLegs: {} }; }
    const spend = await this.spendOf(e);
    if (spend?.preimage) return { status: 'SETTLED', revision: e.revision, deposits: { [e.leg.index]: e.leg.amountBase }, settledLegs: { [e.leg.index]: spend.txid }, settledTx: spend.txid, dealHash: e.dealHash, expiresAt: e.expiresAt };
    if (spend) return { status: 'REFUNDED', revision: e.revision, deposits: {}, settledLegs: {}, refundedTx: spend.txid, dealHash: e.dealHash, expiresAt: e.expiresAt };
    const utxos = await this.htlcUtxos(e);
    const funded = utxos.filter(u => u.confirmations >= this.cfg.confirmations).reduce((s, u) => s + u.valueSat, 0n) >= BigInt(e.leg.amountBase);
    return { status: funded ? 'FUNDED' : 'REGISTERED', revision: e.revision, deposits: funded ? { [e.leg.index]: e.leg.amountBase } : {}, settledLegs: {}, dealHash: e.dealHash, expiresAt: e.expiresAt };
  }

  async waitFinal(ref: string): Promise<TxStatus> {
    const tx = await this.esplora.tx(ref);
    if (!tx) return { ref, status: 'pending', confirmations: 0 };
    if (!tx.status.confirmed || !tx.status.block_height) return { ref, status: 'included', confirmations: 0 };
    const confs = (await this.esplora.tipHeight()) - tx.status.block_height + 1;
    return { ref, status: confs >= this.cfg.confirmations ? 'final' : 'included', confirmations: confs };
  }

  /** MONITORA o gasto do HTLC na rede e extrai a preimage real exposta no witness do claim. */
  async revealedPreimage(dealId: string): Promise<string | null> {
    let e: HtlcEssentials;
    try { e = await this.hydrate(dealId); } catch { return null; }
    const spend = await this.spendOf(e).catch(() => null);
    return spend?.preimage ?? null;
  }

  /** Localiza o gasto de qualquer outpoint do HTLC: claim (witness com preimage) ou refund. */
  private async spendOf(e: HtlcEssentials): Promise<{ txid: string; preimage: string | null } | null> {
    const txs = await this.esplora.addressTxs(e.address);
    for (const tx of txs) {
      for (const vin of tx.vin) {
        const parent = txs.find(t => t.txid === vin.txid) ?? await this.esplora.tx(vin.txid);
        const spendsHtlc = parent?.vout[vin.vout]?.scriptpubkey_address === e.address;
        if (!spendsHtlc || !vin.witness) continue;
        return { txid: tx.txid, preimage: preimageFromWitness(vin.witness, e.htlcHash) };
      }
    }
    return null;
  }
}
