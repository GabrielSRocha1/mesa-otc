// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/crypto/src/base58.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/** Base58 (alfabeto Bitcoin) — usado por Solana e Tron. Implementação sem dependências. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array();
  const bytes: number[] = [0];
  for (const c of s) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error(`caractere base58 inválido: ${c}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const c of s) { if (c === "1") zeros++; else break; }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

export function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}
