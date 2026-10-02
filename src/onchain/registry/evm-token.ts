// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/registry/src/evm-token.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/** Validação de token ERC-20/TRC-20 contra o registry: decimals reais on-chain, nunca metadata de UI. */
export interface Erc20Reader { decimals(address: string): Promise<number>; codeSize(address: string): Promise<number> }

export type Erc20Verdict = { accepted: true; decimals: number } | { accepted: false; reason: string };

export async function validateEvmToken(reader: Erc20Reader, address: string, expectedDecimals: number): Promise<Erc20Verdict> {
  const size = await reader.codeSize(address);
  if (size === 0) return { accepted: false, reason: "endereço sem código (não é contrato)" };
  let d: number;
  try { d = await reader.decimals(address); } catch { return { accepted: false, reason: "decimals() falhou" }; }
  if (d !== expectedDecimals) return { accepted: false, reason: `decimals ${d} ≠ esperado ${expectedDecimals}` };
  return { accepted: true, decimals: d };
}
