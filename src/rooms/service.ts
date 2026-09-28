/**
 * RoomService — salas de operação privadas e convives anti-hijacking (§5).
 *
 * Invariantes de segurança:
 * - Só o PM01 cria a sala e convida (por e-mail/telefone EXATOS); nunca há busca parcial.
 * - Convite é token opaco de 256 bits, guardado só como SHA-256, uso único, TTL 30min, vinculado a
 *   {sala, papel, convidado/índice de contato}. Nunca um link público/estático/reutilizável.
 * - Anti-enumeração: convidar responde de forma idêntica exista ou não a conta.
 * - Aceite exige sessão do destinatário + consumo atômico do token + assinatura da carteira sobre a
 *   mensagem de ingresso {sala, papel, versão, nonce, expiração}.
 * - WebSocket entra por ticket de uso único (TTL 30s) + validação de Origin + autorização por sala.
 * - Encerramento é irreversível: convites revogados, novas mensagens rejeitadas.
 */
import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import type { IdentityService } from '../identity/service.js';
import type { ConfusableAlert, IdentitySnapshot, PublicIdentity } from '../identity/types.js';
import { fingerprintWords } from './wordlist.js';
import { INVITABLE_ROLES, type InvitableRole, type Invitation, type Room, type RoomRole } from './types.js';

export interface RoomActor { userId: string; network: string; address: string }
export type SignatureVerifier = (network: string, message: string, signature: string, address: string) => boolean | Promise<boolean>;
export interface RoomAudit { append(e: { actorType: 'user' | 'system'; actorId: string; category: string; dealId: string | null; payload: Record<string, unknown> }): Promise<unknown> }
/** Notificação content-free (§5.3): nunca leva valores/ativos/endereços/nomes. */
export interface RoomNotifier { notify(userId: string | null, roomId: string): void }
export interface RoomConfig { inviteTtlMs?: number; ticketTtlMs?: number; joinTtlMs?: number; allowedOrigins?: string[]; appDomain?: string }
export interface RoomDeps { identity: IdentityService; verifySignature: SignatureVerifier; now?: () => number; audit?: RoomAudit; notifier?: RoomNotifier; config?: RoomConfig }

interface JoinNonce { roomId: string; role: InvitableRole; userId: string; tokenHash: string; termsVersion: number; expiresAt: number }
interface WsTicket { roomId: string; userId: string; expiresAt: number }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const uniform = (): DomainError => new DomainError('INVALID_INPUT', 'Convite inválido ou expirado');
const TERMS_HASH_RE = /^[0-9a-f]{64}$/i;

export interface RoomView {
  id: string; status: Room['status']; closedReason: string | null;
  terms: { version: number; termsHash: string; fingerprint: string[] } | null;
  members: (PublicIdentity & { role: RoomRole })[];
  invitations: { role: InvitableRole; status: Invitation['status']; expiresAt: number }[];
  confusableAlerts: ConfusableAlert[];
}

export class RoomService {
  readonly events = new EventEmitter();
  private rooms = new Map<string, Room>();
  private byTokenHash = new Map<string, string>();     // tokenHash → roomId
  private joinNonces = new Map<string, JoinNonce>();
  private wsTickets = new Map<string, WsTicket>();
  private alerts = new Map<string, ConfusableAlert[]>(); // roomId → confusable alerts
  private readonly identity: IdentityService;
  private readonly verifySignature: SignatureVerifier;
  private readonly now: () => number;
  private readonly audit?: RoomAudit;
  private readonly notifier?: RoomNotifier;
  private readonly inviteTtl: number; private readonly ticketTtl: number; private readonly joinTtl: number;
  private readonly allowedOrigins: string[]; private readonly appDomain: string;

  constructor(deps: RoomDeps) {
    this.identity = deps.identity; this.verifySignature = deps.verifySignature;
    this.now = deps.now ?? (() => Date.now()); this.audit = deps.audit; this.notifier = deps.notifier;
    const c = deps.config ?? {};
    this.inviteTtl = c.inviteTtlMs ?? 30 * 60_000; this.ticketTtl = c.ticketTtlMs ?? 30_000; this.joinTtl = c.joinTtlMs ?? 5 * 60_000;
    this.allowedOrigins = c.allowedOrigins ?? []; this.appDomain = c.appDomain ?? 'otc.verumcrypto.com';
  }

  private log(category: string, actorId: string, payload: Record<string, unknown>): void { void this.audit?.append({ actorType: 'user', actorId, category, dealId: null, payload }); }
  private room(id: string): Room { const r = this.rooms.get(id); if (!r) throw new DomainError('DEAL_NOT_FOUND', 'Sala inexistente'); return r; }
  private assertPm1(room: Room, actor: RoomActor): void { if (room.pm1UserId !== actor.userId) throw new DomainError('FORBIDDEN', 'Apenas o PM01 da sala'); }

  /* ---------- Criação ---------- */
  createRoom(actor: RoomActor): RoomView {
    this.identity.assertEligible(actor.userId);
    const id = 'room_' + randomUUID();
    const room: Room = { id, pm1UserId: actor.userId, status: 'OPEN', terms: null, invitations: [], members: [{ role: 'PAYMASTER_1', userId: actor.userId, walletCaip10: this.identity.walletOf(actor.userId), joinedAt: this.now() }], createdAt: this.now(), closedReason: null };
    this.rooms.set(id, room);
    this.log('room.created', actor.userId, { roomId: id });
    return this.view(room);
  }

  /** Define/atualiza os termos (fonte da impressão digital). Só PM01, sala aberta. */
  setTerms(roomId: string, actor: RoomActor, terms: { version: number; termsHash: string }): RoomView {
    const room = this.room(roomId); this.assertPm1(room, actor);
    if (room.status !== 'OPEN') throw new DomainError('ILLEGAL_TRANSITION', 'Sala não está aberta');
    if (!Number.isInteger(terms.version) || terms.version < 1) throw new DomainError('INVALID_INPUT', 'Versão inválida');
    if (!TERMS_HASH_RE.test(terms.termsHash)) throw new DomainError('INVALID_INPUT', 'termsHash inválido');
    room.terms = { version: terms.version, termsHash: terms.termsHash.toLowerCase() };
    this.log('room.terms.set', actor.userId, { roomId, version: terms.version });
    return this.view(room);
  }

  /* ---------- Convite (anti-enumeração + token opaco) ---------- */
  invite(roomId: string, actor: RoomActor, input: { role: InvitableRole; email?: string; phone?: string }): { token: string; expiresAt: number; role: InvitableRole } {
    const room = this.room(roomId); this.assertPm1(room, actor);
    if (room.status !== 'OPEN') throw new DomainError('ILLEGAL_TRANSITION', 'Sala não está aberta');
    if (!INVITABLE_ROLES.includes(input.role)) throw new DomainError('INVALID_INPUT', 'Papel não convidável');
    if (room.members.some(m => m.role === input.role)) throw new DomainError('VERSION_CONFLICT', 'Papel já preenchido');
    const lookup = this.identity.lookupByContact({ email: input.email, phone: input.phone });
    // PM01 não convida a si mesmo (cobre PM01 ≠ PM02). Não vaza terceiros.
    if (lookup.userId && lookup.userId === actor.userId) throw new DomainError('INVALID_INPUT', 'Não é possível convidar a si mesmo');
    // Revoga convite pendente anterior do mesmo papel (reemissão).
    for (const inv of room.invitations) if (inv.role === input.role && inv.status === 'pending') { inv.status = 'revoked'; this.byTokenHash.delete(inv.tokenHash); }
    const token = randomBytes(32).toString('base64url'); // 256 bits
    const tokenHash = sha256(token);
    const inv: Invitation = { role: input.role, contactKind: lookup.kind, contactIndex: lookup.index, inviteeUserId: lookup.userId, tokenHash, status: 'pending', createdAt: this.now(), expiresAt: this.now() + this.inviteTtl };
    room.invitations.push(inv); this.byTokenHash.set(tokenHash, roomId);
    this.notifier?.notify(lookup.userId, roomId); // conteúdo neutro; se sem conta, PM entrega o link
    this.log('room.invite.create', actor.userId, { roomId, role: input.role });
    // Resposta idêntica exista ou não a conta (anti-enumeração).
    return { token, expiresAt: inv.expiresAt, role: input.role };
  }

  /** PM01 revoga um convite pendente por papel. */
  revoke(roomId: string, actor: RoomActor, role: InvitableRole): RoomView {
    const room = this.room(roomId); this.assertPm1(room, actor);
    for (const inv of room.invitations) if (inv.role === role && inv.status === 'pending') { inv.status = 'revoked'; this.byTokenHash.delete(inv.tokenHash); }
    this.log('room.invite.revoke', actor.userId, { roomId, role });
    return this.view(room);
  }

  private pendingInvite(room: Room, tokenHash: string): Invitation | undefined {
    const inv = room.invitations.find(i => i.tokenHash === tokenHash);
    if (!inv || inv.status !== 'pending') return undefined;
    if (this.now() > inv.expiresAt) { inv.status = 'expired'; this.byTokenHash.delete(tokenHash); return undefined; }
    return inv;
  }

  private joinMessage(roomId: string, role: RoomRole, termsVersion: number, nonce: string, expiresAt: number): string {
    return [
      `${this.appDomain} — ingresso em operação`, '',
      `Operação: ${roomId}`, `Papel: ${role}`, `Versão dos termos: ${termsVersion}`,
      `Nonce: ${nonce}`, `Expira em: ${new Date(expiresAt).toISOString()}`, '',
      'Assinar confirma seu ingresso na sala; não movimenta fundos e não concede permissões.',
    ].join('\n');
  }

  /** Resolve o token para o destinatário correto e emite a mensagem de ingresso a assinar. */
  resolveInvite(token: string, actor: RoomActor): { roomId: string; role: InvitableRole; termsVersion: number; joinMessage: string; nonce: string; expiresAt: number } {
    const tokenHash = sha256(token);
    const roomId = this.byTokenHash.get(tokenHash);
    if (!roomId) throw uniform();
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'OPEN') throw uniform();
    const inv = this.pendingInvite(room, tokenHash);
    if (!inv) throw uniform();
    // Correspondência do destinatário: por userId (conta conhecida) ou por índice de contato verificado (onboarding).
    const matches = inv.inviteeUserId ? inv.inviteeUserId === actor.userId : this.identity.contactIndexes(actor.userId).includes(inv.contactIndex);
    if (!matches) throw uniform();
    this.identity.assertEligible(actor.userId); // erro próprio do usuário (não enumeração)
    const termsVersion = room.terms?.version ?? 0;
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = this.now() + this.joinTtl;
    this.joinNonces.set(nonce, { roomId, role: inv.role, userId: actor.userId, tokenHash, termsVersion, expiresAt });
    return { roomId, role: inv.role, termsVersion, joinMessage: this.joinMessage(roomId, inv.role, termsVersion, nonce, expiresAt), nonce, expiresAt };
  }

  /** Aceite: consumo atômico do token + assinatura de ingresso verificada contra a carteira da sessão. */
  async acceptInvite(token: string, nonce: string, signature: string, actor: RoomActor): Promise<RoomView> {
    const jn = this.joinNonces.get(nonce);
    if (!jn || jn.userId !== actor.userId || this.now() > jn.expiresAt) throw uniform();
    const tokenHash = sha256(token);
    if (jn.tokenHash !== tokenHash) throw uniform();
    const room = this.room(jn.roomId);
    if (room.status !== 'OPEN') throw new DomainError('ILLEGAL_TRANSITION', 'Sala não está aberta');
    const inv = this.pendingInvite(room, tokenHash);
    if (!inv || inv.role !== jn.role) throw uniform();
    const message = this.joinMessage(jn.roomId, jn.role, jn.termsVersion, nonce, jn.expiresAt);
    const ok = await this.verifySignature(actor.network, message, signature, actor.address);
    if (!ok) throw new DomainError('SIGNATURE_INVALID', 'Assinatura de ingresso inválida');
    // Regras de participação (atômicas).
    if (room.members.some(m => m.userId === actor.userId)) throw new DomainError('INVALID_INPUT', 'Usuário já participa da sala');
    if (room.members.some(m => m.role === inv.role)) throw new DomainError('VERSION_CONFLICT', 'Papel já preenchido');
    const walletCaip10 = this.identity.walletOf(actor.userId);
    if (room.members.some(m => m.walletCaip10 === walletCaip10)) throw new DomainError('INVALID_INPUT', 'Carteira já usada por outro participante');
    if (inv.role === 'PAYMASTER_2' && actor.userId === room.pm1UserId) throw new DomainError('INVALID_INPUT', 'PM01 não pode ser PM02');
    // Consumo atômico (uso único).
    inv.status = 'accepted'; this.joinNonces.delete(nonce); this.byTokenHash.delete(tokenHash);
    room.members.push({ role: inv.role, userId: actor.userId, walletCaip10, joinedAt: this.now() });
    // Sala completa? (sem convites pendentes e ≥3 participantes) → congela snapshot de identidade.
    if (!room.invitations.some(i => i.status === 'pending') && room.members.length >= 3) {
      const snap = this.identity.buildOperationSnapshot(room.members.map(m => ({ role: m.role, userId: m.userId })));
      this.alerts.set(room.id, snap.confusableAlerts);
      room.status = 'FILLED';
      void (snap.snapshots as IdentitySnapshot[]);
    }
    this.log('room.invite.accept', actor.userId, { roomId: room.id, role: inv.role });
    for (const m of room.members) this.notifier?.notify(m.userId, room.id);
    this.events.emit('room', { roomId: room.id, type: 'member_joined', role: inv.role });
    return this.view(room);
  }

  /* ---------- WebSocket: ticket + Origin + autorização por sala ---------- */
  issueWsTicket(roomId: string, actor: RoomActor): { ticket: string; expiresAt: number } {
    const room = this.room(roomId);
    if (!room.members.some(m => m.userId === actor.userId)) throw new DomainError('NOT_PARTICIPANT', 'Não é participante da sala');
    if (room.status === 'CLOSED') throw new DomainError('ILLEGAL_TRANSITION', 'Sala encerrada');
    const ticket = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + this.ticketTtl;
    this.wsTickets.set(ticket, { roomId, userId: actor.userId, expiresAt });
    return { ticket, expiresAt };
  }
  /** Consumo de uso único do ticket de WS (na abertura do socket). */
  consumeWsTicket(ticket: string): { roomId: string; userId: string } {
    const t = this.wsTickets.get(ticket);
    this.wsTickets.delete(ticket); // uso único mesmo se expirado
    if (!t || this.now() > t.expiresAt) throw new DomainError('FORBIDDEN', 'Ticket de WebSocket inválido ou expirado');
    return { roomId: t.roomId, userId: t.userId };
  }
  /** Origin permitida? (vazio = qualquer, para dev). */
  validateOrigin(origin: string | undefined): boolean {
    if (this.allowedOrigins.length === 0) return true;
    return !!origin && this.allowedOrigins.includes(origin);
  }
  /** Autorização por sala em cada mensagem: participante de sala não encerrada. */
  authorizeRoomMessage(roomId: string, userId: string): void {
    const room = this.room(roomId);
    if (room.status === 'CLOSED') throw new DomainError('ILLEGAL_TRANSITION', 'Sala encerrada');
    if (!room.members.some(m => m.userId === userId)) throw new DomainError('NOT_PARTICIPANT', 'Não é participante da sala');
  }

  /* ---------- Encerramento irreversível ---------- */
  close(roomId: string, actor: RoomActor, reason: string): RoomView { this.room(roomId); this.assertPm1(this.room(roomId), actor); return this.doClose(roomId, actor.userId, reason); }
  /** Encerramento pelo sistema (ex.: deal em estado terminal). */
  closeBySystem(roomId: string, reason: string): void { if (this.rooms.has(roomId)) this.doClose(roomId, 'system', reason); }
  private doClose(roomId: string, actorId: string, reason: string): RoomView {
    const room = this.room(roomId);
    if (room.status !== 'CLOSED') {
      room.status = 'CLOSED'; room.closedReason = reason;
      for (const inv of room.invitations) if (inv.status === 'pending') { inv.status = 'revoked'; this.byTokenHash.delete(inv.tokenHash); }
      for (const [n, jn] of this.joinNonces) if (jn.roomId === roomId) this.joinNonces.delete(n);
      for (const [t, w] of this.wsTickets) if (w.roomId === roomId) this.wsTickets.delete(t);
      this.log('room.closed', actorId, { roomId, reason });
      this.events.emit('room', { roomId, type: 'closed', reason });
    }
    return this.view(room);
  }

  /* ---------- Views ---------- */
  getView(roomId: string, requesterUserId: string): RoomView {
    const room = this.room(roomId);
    if (!room.members.some(m => m.userId === requesterUserId)) throw new DomainError('NOT_PARTICIPANT', 'Não é participante da sala');
    return this.view(room);
  }
  private view(room: Room): RoomView {
    return {
      id: room.id, status: room.status, closedReason: room.closedReason,
      terms: room.terms ? { version: room.terms.version, termsHash: room.terms.termsHash, fingerprint: fingerprintWords(room.terms.termsHash) } : null,
      members: room.members.map(m => ({ ...this.identity.publicView(m.userId, m.role), role: m.role })),
      invitations: room.invitations.map(i => ({ role: i.role, status: i.status, expiresAt: i.expiresAt })),
      confusableAlerts: this.alerts.get(room.id) ?? [],
    };
  }

  /** Texto de notificação content-free (§5.3) — sem valores, ativos, endereços ou nomes. */
  static notificationText(roomId: string): string { return `Há uma atualização na operação ${shortRef(roomId)}. Abra o VERUM OTC.`; }
}

function shortRef(roomId: string): string { const s = roomId.replace(/[^a-z0-9]/gi, ''); return '#' + s.slice(-6).toUpperCase(); }
