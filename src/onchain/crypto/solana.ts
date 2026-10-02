// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/crypto/src/solana.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * Hashing determinístico para o programa Solana (programs/verum_otc/src/terms.rs).
 * Layout byte a byte (little-endian onde aplicável) — qualquer alteração exige bump de TERMS_VERSION.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Role, type Terms } from "../types.js";
import { base58Decode } from "./base58.js";

export const SOLANA_TERMS_DOMAIN = new TextEncoder().encode("VERUM_OTC_TERMS_V1");
export const SOLANA_TRADE_DOMAIN = new TextEncoder().encode("VERUM_OTC_TRADE_V1");
export const SOLANA_APPROVAL_DOMAIN = new TextEncoder().encode("VERUM_OTC_APPROVAL_V1");

function pubkey(b58: string): Uint8Array {
  const b = base58Decode(b58);
  if (b.length !== 32) throw new Error(`pubkey Solana inválida: ${b58}`);
  return b;
}
function u16(n: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function u64(n: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function i64(n: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; }
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Serialização canônica dos termos (espelha `Terms::to_bytes` em Rust). */
export function serializeTermsSolana(t: Terms): Uint8Array {
  return cat(
    pubkey(t.seller), pubkey(t.buyer), pubkey(t.paymaster01), pubkey(t.paymaster02),
    pubkey(t.sellerAsset), u64(t.sellerAmount), pubkey(t.buyerAsset), u64(t.buyerAmount),
    u16(t.platformFeeBps), u16(t.commissionBps), u16(t.discountBps), u16(t.slippageBps),
    i64(t.createdAt), i64(t.expiresAt), u32(t.termsVersion), u64(t.nonce),
  );
}

export function hashTermsSolana(t: Terms): Uint8Array {
  return sha256(cat(SOLANA_TERMS_DOMAIN, serializeTermsSolana(t)));
}

/** trade_id = sha256("VERUM_OTC_TRADE_V1" || program_id || terms_hash). */
export function computeTradeIdSolana(programId: string, termsHash: Uint8Array): Uint8Array {
  return sha256(cat(SOLANA_TRADE_DOMAIN, pubkey(programId), termsHash));
}

/**
 * Mensagem de aprovação. Na Solana a "assinatura" do participante é a assinatura ed25519 da própria
 * transação (conta Signer) cujos dados de instrução carregam este hash; o programa recomputa e compara.
 */
export function approvalMessageSolana(tradeId: Uint8Array, termsHash: Uint8Array, role: Role, deadline: number): Uint8Array {
  return sha256(cat(SOLANA_APPROVAL_DOMAIN, tradeId, termsHash, new Uint8Array([role]), i64(deadline)));
}

export const toHex = (b: Uint8Array): string => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string): Uint8Array => {
  const s = h.replace(/^0x/, "");
  if (s.length % 2) throw new Error("hex ímpar");
  return new Uint8Array(s.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
};
