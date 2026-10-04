/**
 * Status da mesa DERIVADO (função pura) — nenhuma máquina de estados paralela: cadeiras/convites
 * vêm do portal, a operação vem do DealEngine. Transições reais só acontecem lá.
 */
import type { MesaInviteRow } from '../db/repository.js';
import type { Deal } from '../domain/types.js';
import type { MesaRecord, MesaStatus } from './types.js';

export function deriveMesaStatus(mesa: MesaRecord, invites: MesaInviteRow[], deal: Deal | null, now: number): MesaStatus {
  if (mesa.cancelled) return 'CANCELLED';
  // Operação em andamento/terminada manda no estado.
  if (deal) {
    switch (deal.state) {
      case 'SETTLED': return 'COMPLETED';
      case 'CANCELLED': return 'CANCELLED';
      case 'BLOCKED': case 'REFUNDING': case 'REFUNDED': return 'FAILED';
      case 'EXPIRED':
        // Com ≥1 assinatura válida a expiração veio da janela de assinatura (5 min/turno).
        return deal.validSignatures > 0 ? 'SIGNATURE_TIMEOUT' : (now >= mesa.expiresAt ? 'EXPIRED' : 'SIGNATURE_TIMEOUT');
      case 'AWAITING_SIGNATURES':
        // Janela do turno estourada: o engine expira a deal no próximo toque/scan; o status
        // derivado reflete o timeout imediatamente (novas assinaturas já são rejeitadas lá).
        if (deal.turnExpiresAt != null && now >= deal.turnExpiresAt) return 'SIGNATURE_TIMEOUT';
        return deal.validSignatures > 0 ? 'SIGNING' : 'WAITING_SIGNATURES';
      case 'FULLY_SIGNED': case 'SETTLEMENT_VALIDATION': case 'SETTLING': return 'SIGNING';
      default: return 'APPROVED'; // deal criada na aprovação, ainda antes da coleta de assinaturas
    }
  }
  if (now >= mesa.expiresAt) return 'EXPIRED';
  const connected = (c: MesaRecord['chairs'][number]): boolean => !!c.wallet;
  const allConnected = mesa.chairs.every(connected);
  if (allConnected) {
    if (mesa.approvedAt) return 'APPROVED';
    return mesa.config ? 'READY_FOR_APPROVAL' : 'ACTIVE';
  }
  const open = new Map<string, MesaInviteRow>();
  for (const i of invites) if (i.status === 'PENDING' && i.expiresAt > now) open.set(i.chairId, i);
  const missingInvite = mesa.chairs.some(c => !connected(c) && c.role !== 'PAYMASTER_1' && !open.has(c.chairId));
  if (invites.length === 0 && mesa.chairs.every(c => c.role === 'PAYMASTER_1' || !connected(c))) return missingInvite ? 'DRAFT' : 'WAITING_CONNECTIONS';
  return missingInvite ? 'WAITING_INVITES' : 'WAITING_CONNECTIONS';
}
