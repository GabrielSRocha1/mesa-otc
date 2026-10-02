// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/crypto/src/tron.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * Tron usa o mesmo contrato Solidity (VerumOTCEscrowTron) com chain id injetado.
 * Endereços Tron (base58 'T...') = 0x41 || 20 bytes || checksum(4). Para EIP-712 usamos os 20 bytes.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { Hex } from "viem";
import { base58Decode, base58Encode } from "./base58.js";

export const TRON_MAINNET_CHAIN_ID = 0x2b6653dc; // 728126428
export const TRON_NILE_CHAIN_ID = 0xcd8690dc; // 3448148188
export const TRON_SHASTA_CHAIN_ID = 0x94a9059e; // 2494104990

export function tronToEvmAddress(tronBase58: string): Hex {
  const raw = base58Decode(tronBase58);
  if (raw.length !== 25 || raw[0] !== 0x41) throw new Error(`endereço Tron inválido: ${tronBase58}`);
  const payload = raw.slice(0, 21);
  const check = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) if (check[i] !== raw[21 + i]) throw new Error("checksum Tron inválido");
  return ("0x" + Array.from(payload.slice(1), (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

export function evmToTronAddress(evm: Hex): string {
  const hex = evm.replace(/^0x/, "");
  if (hex.length !== 40) throw new Error("endereço EVM inválido");
  const payload = new Uint8Array([0x41, ...(hex.match(/../g)!.map((x) => parseInt(x, 16)))]);
  const check = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(new Uint8Array([...payload, ...check]));
}
