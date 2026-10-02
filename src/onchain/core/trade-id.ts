// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/core/src/trade-id.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * Identificador humano da mesa (ex.: "MESA-2562-39WH-KSS4") derivado do tradeId criptográfico.
 * Não é autoridade: a autoridade é o tradeId (hash) on-chain. Serve apenas para a UI existente.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I

export function humanTradeCode(tradeIdHex: string): string {
  const hex = tradeIdHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("tradeId deve ter 32 bytes hex");
  const bytes = Buffer.from(hex, "hex");
  const pick = (i: number) => ALPHABET[bytes[i]! % ALPHABET.length]!;
  const num = ((bytes[0]! << 8) | bytes[1]!) % 10_000;
  return `MESA-${String(num).padStart(4, "0")}-${pick(2)}${pick(3)}${pick(4)}${pick(5)}-${pick(6)}${pick(7)}${pick(8)}${pick(9)}`;
}
