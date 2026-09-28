/**
 * Tipos das salas de operação e convites (§5). O estado é autoritativo no servidor;
 * o cliente só recebe eventos. Tokens de convite e tickets de WS existem apenas como hash.
 */
import { z } from 'zod';

export type RoomRole = 'SELLER' | 'BUYER' | 'PAYMASTER_1' | 'PAYMASTER_2';
/** Papéis convidáveis (PM01 é o criador da sala, não convidado). */
export const INVITABLE_ROLES = ['SELLER', 'BUYER', 'PAYMASTER_2'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export type RoomStatus = 'OPEN' | 'FILLED' | 'CLOSED';
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invitation {
  role: InvitableRole;
  contactKind: 'email' | 'phone';
  contactIndex: string;            // blind index HMAC do contato (nunca o valor)
  inviteeUserId: string | null;    // conhecido só se a conta já existir
  tokenHash: string;               // SHA-256 do token opaco (o token nunca é persistido)
  status: InviteStatus;
  createdAt: number;
  expiresAt: number;
}

export interface Membership { role: RoomRole; userId: string; walletCaip10: string; joinedAt: number }

export interface RoomTerms { version: number; termsHash: string }

export interface Room {
  id: string;
  pm1UserId: string;
  status: RoomStatus;
  terms: RoomTerms | null;
  invitations: Invitation[];
  members: Membership[];
  createdAt: number;
  closedReason: string | null;
}

/** Mensagens que o cliente PODE enviar no WS (estado é autoritativo no servidor). */
export const WsClientMessage = z.union([
  z.object({ type: z.literal('ping') }).strict(),
  z.object({ type: z.literal('subscribe') }).strict(),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;
