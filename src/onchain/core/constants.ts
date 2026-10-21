// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/core/src/constants.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/** Constantes de negócio da Verum OTC. Espelhadas no contrato EVM/Tron e no programa Solana. */
export const TRADE_DURATION_SECONDS = 40 * 60; // 2400 s — NUNCA 45 minutos
export const CREATION_WINDOW_SECONDS = 5 * 60;
export const PLATFORM_FEE_BPS = 3; // 0,03% = 0,0003
export const MAX_PLATFORM_FEE_BPS = 100; // teto 1%
export const BPS_DENOMINATOR = 10_000n;
export const TERMS_VERSION = 1;
export const PARTICIPANT_COUNT = 4;
/** Sentinela do ativo NATIVO EVM (EIP-7528) no escrow V2: perna em ETH puro, sem WETH — o
 *  depósito vai como msg.value no signV2 (payable) e o payout/refund sai por call{value}.
 *  Espelho de VerumOTCEscrowV2Base.NATIVE_ASSET. address(0) segue sendo perna EXTERNA (HTLC). */
export const NATIVE_ASSET_EVM = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
