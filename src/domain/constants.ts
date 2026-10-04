/**
 * Parâmetros canônicos da plataforma (fonte única — proibido número mágico em componente).
 * Todos os timers derivam daqui e correm pelo relógio do SERVIDOR (nunca Date.now() do navegador
 * como autoridade). Valores idênticos aos já praticados pelo código — nenhuma semântica muda.
 */
export const TABLE_TTL_MINUTES = 60;        // vida da mesa desde a criação; ao zerar → EXPIRED
export const SIGN_WINDOW_MINUTES = 5;       // janela rolante por assinante (inicia na vez dele)
export const INVITE_TTL_MINUTES = 60;       // convite nunca vive mais que a mesa (clampado na emissão)
export const CHALLENGE_TTL_SECONDS = 300;   // challenge de posse (nonce de uso único)
export const MIN_GAS_USD = 5;               // saldo mínimo do token nativo por wallet (via serviço de preço)
/** Fallback por rede quando não há preço disponível para converter MIN_GAS_USD. */
export const MIN_GAS_NATIVE_FALLBACK: Record<string, number> = { solana: 0.05 };
export const PLATFORM_FEE_BPS_DEFAULT = 3;  // 0,03 % (já existente em config.PLATFORM_FEE_BPS)

export const TABLE_TTL_MS = TABLE_TTL_MINUTES * 60_000;
export const SIGN_WINDOW_MS = SIGN_WINDOW_MINUTES * 60_000;
export const INVITE_TTL_MS = INVITE_TTL_MINUTES * 60_000;
export const CHALLENGE_TTL_MS = CHALLENGE_TTL_SECONDS * 1000;

/** Ordem obrigatória de assinatura (fonte canônica em domain/types.ts — reexportada aqui). */
export { SIGNING_ORDER } from './types.js';

/** Alfabeto do inviteCode XXXX-XXXX: sem caracteres ambíguos 0 O 1 I L. */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
