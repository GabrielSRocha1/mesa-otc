/**
 * Tipos do módulo de identidade mínima (§2). A conta guarda EXCLUSIVAMENTE os quatro
 * elementos admitidos — carteira (pública), nome, e-mail, telefone — sendo os três
 * últimos cifrados em nível de campo. Nenhum outro dado pessoal existe no modelo.
 */
import { z } from 'zod';

/** Gancho de extensibilidade (§2). Único valor implementado hoje. */
export type VerificationLevel = 'BASIC';

export type AccountStatus = 'active' | 'shredded';

/** Endereço de liquidação adicional (público, CAIP-10), após prova de posse na própria rede. */
export interface SettlementAddress { caip10: string; verifiedAt: number }

/**
 * Registro de conta com o formato de uma linha de tabela. Campos pessoais existem
 * SOMENTE cifrados (`*Enc`) ou como índice cego (`*Index`, HMAC não reversível).
 * `walletCaip10` e `settlementAddresses` são públicos por natureza (endereços on-chain).
 */
export interface AccountRow {
  id: string;
  status: AccountStatus;
  verificationLevel: VerificationLevel;
  walletCaip10: string;               // carteira de identidade (pública)
  walletVerifiedAt: number | null;
  fullNameEnc: string | null;         // AES-256-GCM (envelope)
  fullNameSetAt: number | null;
  emailEnc: string | null;            // AES-256-GCM
  emailIndex: string | null;          // HMAC-SHA256 (busca exata)
  emailVerifiedAt: number | null;
  phoneEnc: string | null;            // AES-256-GCM
  phoneIndex: string | null;          // HMAC-SHA256
  phoneVerifiedAt: number | null;
  wrappedDek: string | null;          // DEK protegida pelo KMS; null após crypto-shredding
  settlementAddresses: SettlementAddress[];
  createdAt: number;
  updatedAt: number;
}

/** Nomes das colunas — usado pelo teste de schema que barra qualquer PII além das 4 permitidas. */
export const ACCOUNT_COLUMNS: readonly (keyof AccountRow)[] = [
  'id', 'status', 'verificationLevel', 'walletCaip10', 'walletVerifiedAt',
  'fullNameEnc', 'fullNameSetAt', 'emailEnc', 'emailIndex', 'emailVerifiedAt',
  'phoneEnc', 'phoneIndex', 'phoneVerifiedAt', 'wrappedDek', 'settlementAddresses',
  'createdAt', 'updatedAt',
];

/** Visão de um participante para os DEMAIS da mesma operação (§2 "Quem vê"). */
export interface PublicIdentity {
  userId: string;
  role?: string;
  walletCaip10: string;
  fullName: string;          // nome completo é visível aos co-participantes
  emailMasked: string;       // e-mail apenas mascarado
  phoneMasked: string;       // telefone apenas mascarado
  emailVerifiedAt: number | null;
  phoneVerifiedAt: number | null;
  verificationLevel: VerificationLevel;
}

/** Snapshot de identidade congelado nos termos assinados (§2, §6). Sem valores de contato. */
export interface IdentitySnapshot {
  role: string;
  userId: string;
  walletCaip10: string;
  fullName: string;
  emailVerifiedAt: number | null;
  phoneVerifiedAt: number | null;
  verificationLevel: VerificationLevel;
}

/** Alerta de nomes confundíveis entre participantes (§2 detecção de impersonação). */
export interface ConfusableAlert { a: { userId: string; role: string }; b: { userId: string; role: string } }

/* ---------- DTOs de entrada (zod). Nenhum contém PII além do dado a verificar. ---------- */
export const SetNameInput = z.object({ fullName: z.string().min(1).max(200) }).strict();
export const StartEmailInput = z.object({ email: z.string().min(1).max(200) }).strict();
export const StartPhoneInput = z.object({ phone: z.string().min(1).max(40) }).strict();
export const ConfirmContactInput = z.object({ challengeId: z.string().min(10).max(64), code: z.string().min(4).max(12) }).strict();
export const AddSettlementInput = z.object({ caip10: z.string().min(6).max(120) }).strict();

/** DTOs expostos para o teste que barra campos pessoais na entrada. */
export const INPUT_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  SetNameInput, StartEmailInput, StartPhoneInput, ConfirmContactInput, AddSettlementInput,
};
