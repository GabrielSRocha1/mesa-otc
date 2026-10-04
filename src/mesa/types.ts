/**
 * Mesa multi-instância (v3): o Pay Master cria N mesas com 3–4 cadeiras SEM cadastrar wallet de
 * ninguém — a wallet real é identificada na conexão, com prova de posse por assinatura.
 * Mesas/cadeiras vivem no PortalData (JSONB serverless-safe); convites vivem em tabela SQL
 * própria (mesa_invites) para consumo atômico entre instâncias.
 */
import type { WalletLink } from '../portal/portal.js';

export type MesaChairRole = 'SELLER' | 'BUYER' | 'PAYMASTER_1' | 'PAYMASTER_2';
/** Papéis convidáveis (a cadeira PAYMASTER_1 é do próprio admin, já conectada). */
export const INVITABLE_CHAIR_ROLES: readonly MesaChairRole[] = ['SELLER', 'BUYER', 'PAYMASTER_2'];

/** Ativo esperado por identidade real (rede + contrato/mint + decimais) — nunca só símbolo. */
export interface ChairAsset { network: string; contractOrMint: string | null; decimals: number; symbol: string }

export interface MesaChair {
  chairId: string;
  role: MesaChairRole;
  expectedAsset: ChairAsset;
  /** Rótulo interno do admin (ex.: "cliente da reunião de terça") — NUNCA exposto aos participantes. */
  label?: string;
  wallet: WalletLink | null;          // preenchido só após convite válido + challenge assinado
  firstName?: string;                 // o nome exibido é o que o PRÓPRIO participante digita
  connectedAt?: number;
}

/** Configuração da operação (editável só pelo admin; congelada na aprovação). */
export interface MesaOperationConfig {
  amountInBase?: string;
  discountBps: number;
  commissionBps: number;
  commissionPayer?: 'SELLER' | 'BUYER' | 'SPLIT';
  notes?: string;
}

export interface MesaRecord {
  mesaId: string;
  payMasterId: string;
  code: string;                       // gerador existente MESA-XXXX-XXXX-XXXX
  label?: string;
  network: string;                    // uma mesa = uma rede
  chairs: MesaChair[];                // 3–4
  approvals: Record<string, { at: number }>;
  config?: MesaOperationConfig;
  approvedAt?: number;
  /** Hash dos termos congelados na aprovação (config + cadeiras + ativos). */
  termsHash?: string;
  dealId: string | null;
  dealIds: string[];
  createdAt: number;
  expiresAt: number;                  // createdAt + TABLE_TTL
  cancelled?: { at: number; reason: string };
}

export type MesaStatus =
  | 'DRAFT' | 'WAITING_INVITES' | 'WAITING_CONNECTIONS' | 'ACTIVE' | 'READY_FOR_APPROVAL'
  | 'APPROVED' | 'WAITING_SIGNATURES' | 'SIGNING' | 'COMPLETED'
  | 'SIGNATURE_TIMEOUT' | 'EXPIRED' | 'CANCELLED' | 'FAILED';

export const MESA_TERMINAL_STATUSES: ReadonlySet<MesaStatus> = new Set(['COMPLETED', 'SIGNATURE_TIMEOUT', 'EXPIRED', 'CANCELLED', 'FAILED']);
