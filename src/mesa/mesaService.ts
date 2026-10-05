/**
 * MesaService (v3) — mesas multi-instância com cadeiras e convites por cadeira.
 * Regra central: o Pay Master NUNCA cadastra endereço de wallet; cria cadeiras e convites.
 * A wallet real é identificada na conexão, com prova de posse por challenge assinado
 * (reutiliza nonces/verificadores do WalletAuth) e consumo ATÔMICO do convite (tabela SQL).
 * O estado da operação continua 100% no DealEngine; o status da mesa é derivado (status.ts).
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyMessage } from 'viem';
import { DomainError } from '../domain/errors.js';
import { sha256Hex, canonicalize, NETWORK_KEY_SCHEME, type Network } from '../domain/types.js';
import { TABLE_TTL_MS, INVITE_TTL_MS, CHALLENGE_TTL_MS, INVITE_CODE_ALPHABET } from '../domain/constants.js';
import type { MesaInviteRow, Store } from '../db/repository.js';
import type { PortalService, WalletAddress } from '../portal/portal.js';
import type { WalletAuth, Session } from '../wallet/auth.js';
import type { AuditLog } from '../audit/audit.js';
import type { Deal } from '../domain/types.js';
import { verifySolana, verifyTron, verifyBitcoin } from '../engines/signature.js';
import { getChain } from '../chains/registry.js';
import { deriveMesaStatus } from './status.js';
import { deriveSettlementPlan } from './settlementPlan.js';
import { INVITABLE_CHAIR_ROLES, type ChairAsset, type MesaChair, type MesaChairRole, type MesaOperationConfig, type MesaRecord, type MesaStatus } from './types.js';

export const CHAIR_ROLE_LABEL: Record<MesaChairRole, string> = { SELLER: 'Vendedor', BUYER: 'Comprador', PAYMASTER_1: 'Pay Master 1', PAYMASTER_2: 'Pay Master 2' };

/** Rede de autenticação suportada pela prova de posse (Verum é Solana por baixo; EVMs assinam EIP-191). */
export type AuthNetwork = 'ethereum' | 'solana' | 'tron' | 'bitcoin';
const EVM_KEYS = new Set(['ethereum', 'bsc', 'polygon', 'arbitrum', 'base', 'avalanche', 'cronos', 'optimism']);
export function authNetworkFor(chainKey: string): AuthNetwork {
  if (chainKey === 'bitcoin') return 'bitcoin';
  if (chainKey === 'tron') return 'tron';
  if (EVM_KEYS.has(chainKey)) return 'ethereum';
  return 'solana';
}

/** Código do convite XXXX-XXXX — CSPRNG com alfabeto sem caracteres ambíguos (rejection sampling). */
export function newInviteCode(): string {
  const chars: string[] = [];
  while (chars.length < 8) {
    const b = randomBytes(1)[0] as number;
    if (b >= 256 - (256 % INVITE_CODE_ALPHABET.length)) continue; // sem viés
    chars.push(INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length] as string);
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const codeHashOf = (inviteId: string, code: string): string => sha256Hex(`${inviteId}:${normalizeCode(code)}`);
const hashesEqual = (a: string, b: string): boolean => { const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex'); return x.length === y.length && timingSafeEqual(x, y); };

const FIRST_NAME_RE = /^.{2,30}$/;

export interface MesaServiceDeps {
  portal: PortalService;
  store: Store;
  audit: AuditLog;
  auth: WalletAuth;
  getDeal: (id: string) => Promise<Deal | null>;
  /** Base pública dos links de convite (ex.: https://otc.verumcrypto.com). */
  baseUrl: string;
  walletDownloadUrl?: string;
  now?: () => number;
}

export interface CreateMesaChairInput { role: MesaChairRole; expectedAsset: ChairAsset; label?: string }
export interface CreateMesaInput { label?: string; network: string; chairs: CreateMesaChairInput[] }

export class MesaService {
  private readonly now: () => number;
  constructor(private readonly d: MesaServiceDeps) { this.now = d.now ?? (() => Date.now()); }

  /** Relógio do serviço (injetável nos testes) — autoridade dos timers também nas rotas. */
  nowMs(): number { return this.now(); }

  private audit(category: string, actorId: string, payload: Record<string, unknown>): Promise<void> {
    return this.d.audit.append({ actorType: 'user', actorId, category, dealId: null, payload }).then(() => undefined);
  }

  /* ---------- criação e leitura (admin) ---------- */

  createMesa(portalToken: string | undefined, input: CreateMesaInput): MesaRecord {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const roles = input.chairs.map(c => c.role);
    // Escrow dinâmico (v4): 2 cadeiras (bilateral), 3 (com Pay Master) ou 4 (dois Pay Masters).
    if (input.chairs.length < 2 || input.chairs.length > 4) throw new DomainError('INVALID_INPUT', 'A mesa precisa de 2 a 4 cadeiras');
    if (new Set(roles).size !== roles.length) throw new DomainError('INVALID_INPUT', 'Cada função aparece no máximo uma vez');
    for (const r of ['SELLER', 'BUYER'] as MesaChairRole[]) if (!roles.includes(r)) throw new DomainError('INVALID_INPUT', `A mesa precisa da cadeira ${CHAIR_ROLE_LABEL[r]}`);
    if (roles.includes('PAYMASTER_2') && !roles.includes('PAYMASTER_1')) throw new DomainError('INVALID_INPUT', 'Pay Master 2 exige a cadeira Pay Master 1');
    if (!input.network || typeof input.network !== 'string') throw new DomainError('INVALID_INPUT', 'Rede da mesa obrigatória (uma mesa = uma rede)');
    const t = this.now();
    const chairs: MesaChair[] = input.chairs.map(c => {
      const asset = c.expectedAsset;
      if (!asset || typeof asset.symbol !== 'string' || typeof asset.decimals !== 'number') throw new DomainError('INVALID_INPUT', `Ativo esperado inválido na cadeira ${CHAIR_ROLE_LABEL[c.role]}`);
      const chair: MesaChair = { chairId: 'ch_' + randomUUID(), role: c.role, expectedAsset: { network: asset.network || input.network, contractOrMint: asset.contractOrMint ?? null, decimals: asset.decimals, symbol: asset.symbol }, label: c.label?.trim() || undefined, wallet: null };
      // A cadeira Pay Master 1 é do próprio admin — já conectada com a wallet dele (quando houver).
      if (c.role === 'PAYMASTER_1' && pm.wallet) { chair.wallet = pm.wallet; chair.firstName = pm.name.split(/\s+/)[0]; chair.connectedAt = t; }
      return chair;
    });
    const mesa: MesaRecord = { mesaId: 'mesa_' + randomUUID(), payMasterId: pm.id, code: this.d.portal.newMesaCode(), operationCode: `OP-${newInviteCode()}`, label: input.label?.trim() || undefined, network: input.network, chairs, approvals: {}, dealId: null, dealIds: [], createdAt: t, expiresAt: t + TABLE_TTL_MS };
    this.d.portal.mesas()[mesa.mesaId] = mesa;
    this.d.portal.persistMesas();
    void this.audit('mesa.criada', pm.id, { mesaId: mesa.mesaId, code: mesa.code, network: mesa.network, chairs: chairs.map(c => ({ chairId: c.chairId, role: c.role })) });
    return mesa;
  }

  /** Mesa do admin (lança FORBIDDEN se não for o dono). */
  private mesaOf(pmId: string, mesaId: string): MesaRecord {
    const mesa = this.d.portal.mesas()[mesaId];
    if (!mesa || mesa.payMasterId !== pmId) throw new DomainError('FORBIDDEN', 'Mesa não encontrada para este Pay Master');
    return mesa;
  }
  /** Mesa por id (participante já autorizado pela sessão). */
  mesaById(mesaId: string): MesaRecord | null { return this.d.portal.mesas()[mesaId] ?? null; }

  async listMesas(portalToken: string | undefined): Promise<{ mesaId: string; code: string; operationCode: string | null; label?: string; network: string; status: MesaStatus; chairs: { role: MesaChairRole; firstName: string | null; connected: boolean }[]; amount: string | null; createdAt: number; expiresAt: number }[]> {
    const pm = this.d.portal.requirePayMaster(portalToken, false);
    const mesas = Object.values(this.d.portal.mesas()).filter(m => m.payMasterId === pm.id).sort((a, b) => b.createdAt - a.createdAt);
    const out = [];
    for (const m of mesas) {
      const status = await this.statusOf(m);
      out.push({ mesaId: m.mesaId, code: m.code, operationCode: m.operationCode ?? null, label: m.label, network: m.network, status, chairs: m.chairs.map(c => ({ role: c.role, firstName: c.firstName ?? null, connected: !!c.wallet })), amount: m.config?.amountInBase ?? null, createdAt: m.createdAt, expiresAt: m.expiresAt });
    }
    return out;
  }

  async statusOf(mesa: MesaRecord): Promise<MesaStatus> {
    const invites = await this.d.store.listMesaInvites(mesa.mesaId);
    const deal = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    return deriveMesaStatus(mesa, invites, deal, this.now());
  }

  /* ---------- convites por cadeira ---------- */

  async createChairInvite(portalToken: string | undefined, mesaId: string, chairId: string): Promise<{ inviteId: string; code: string; link: string; message: string; expiresAt: number; role: MesaChairRole }> {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    this.assertMesaOpen(mesa);
    const chair = mesa.chairs.find(c => c.chairId === chairId);
    if (!chair) throw new DomainError('INVALID_INPUT', 'Cadeira inexistente nesta mesa');
    if (!INVITABLE_CHAIR_ROLES.includes(chair.role)) throw new DomainError('INVALID_INPUT', 'A cadeira do Pay Master 1 é do próprio admin — não recebe convite');
    if (chair.wallet) throw new DomainError('VERSION_CONFLICT', 'Cadeira já conectada. Revogue a conexão antes de convidar outra wallet.');
    // Revoga o convite pendente anterior desta cadeira (índice único garante no máx. 1 PENDING).
    for (const i of await this.d.store.listMesaInvites(mesaId)) if (i.chairId === chairId && i.status === 'PENDING') await this.d.store.revokeMesaInvite(i.inviteId, mesaId);
    const t = this.now();
    const inviteId = randomBytes(18).toString('base64url');
    const code = newInviteCode();
    const expiresAt = Math.min(t + INVITE_TTL_MS, mesa.expiresAt); // convite nunca vive mais que a mesa
    const row: MesaInviteRow = { inviteId, mesaId, chairId, codeHash: codeHashOf(inviteId, code), codePrefix: normalizeCode(code).slice(0, 4), status: 'PENDING', usedByAddress: null, usedByName: null, usedAt: null, createdAt: t, expiresAt };
    await this.d.store.insertMesaInvite(row);
    void this.audit('mesa.convite.gerado', pm.id, { mesaId, chairId, inviteId, role: chair.role });
    const link = `${this.d.baseUrl}/otc/convite/${encodeURIComponent(inviteId)}?c=${encodeURIComponent(code)}`;
    return { inviteId, code, link, message: this.inviteMessage(mesa, chair, code, link, expiresAt), expiresAt, role: chair.role };
  }

  /** Mensagem pronta (o admin envia pelo canal que quiser; a plataforma não integra nenhum). */
  private inviteMessage(mesa: MesaRecord, chair: MesaChair, code: string, link: string, expiresAt: number): string {
    const asset = `${chair.expectedAsset.symbol}`;
    const netLabel = getChain(mesa.network)?.displayName ?? mesa.network;
    const nativo = getChain(chair.expectedAsset.network)?.nativeSymbol ?? getChain(mesa.network)?.nativeSymbol ?? 'SOL';
    const download = this.d.walletDownloadUrl ?? 'https://www.verumcrypto.com/wallet';
    const validade = new Date(expiresAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return [
      'VERUM OTC — Convite para mesa de negociação', '',
      `Mesa: ${mesa.code}`,
      `Sua função: ${CHAIR_ROLE_LABEL[chair.role]}`,
      `Ativo: ${asset} (${netLabel})`,
      `Código do convite: ${code}`,
      `Link: ${link}`, '',
      'Importante — esta mesa aceita conexão somente pela Verum Wallet.',
      `1. Se ainda não tem a Verum Wallet, instale pelo link: ${download}`,
      '2. Abra o link do convite dentro da Verum Wallet.',
      `3. Antes de entrar, carregue a carteira com o ativo que vai negociar (${asset}) no volume combinado`,
      `   e com no mínimo US$ 5 em ${nativo} para pagar as taxas de rede — sem isso a operação trava.`,
      `Válido até: ${validade}`,
    ].join('\n');
  }

  async revokeInvite(portalToken: string | undefined, mesaId: string, inviteId: string): Promise<void> {
    const pm = this.d.portal.requirePayMaster(portalToken);
    this.mesaOf(pm.id, mesaId);
    const ok = await this.d.store.revokeMesaInvite(inviteId, mesaId);
    if (!ok) throw new DomainError('INVALID_INPUT', 'Convite não está pendente (já usado, revogado ou inexistente)');
    void this.audit('mesa.convite.revogado', pm.id, { mesaId, inviteId });
  }

  /** Admin revoga a CONEXÃO de uma cadeira (única forma de substituir a wallet — nunca automática). */
  async revokeChair(portalToken: string | undefined, mesaId: string, chairId: string): Promise<void> {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    if (mesa.approvedAt) throw new DomainError('VERSION_CONFLICT', 'Operação já aprovada — não é possível trocar participantes');
    const chair = mesa.chairs.find(c => c.chairId === chairId);
    if (!chair) throw new DomainError('INVALID_INPUT', 'Cadeira inexistente');
    chair.wallet = null; chair.firstName = undefined; chair.connectedAt = undefined;
    delete mesa.approvals[chairId];
    this.d.portal.persistMesas();
    void this.audit('mesa.cadeira.desconectada', pm.id, { mesaId, chairId });
  }

  /* ---------- fluxo público do participante ---------- */

  private async inviteOrThrow(inviteId: string): Promise<{ invite: MesaInviteRow; mesa: MesaRecord; chair: MesaChair }> {
    const invite = await this.d.store.getMesaInvite(inviteId);
    if (!invite) throw new DomainError('INVALID_INPUT', 'Convite inválido ou expirado.');
    const mesa = this.d.portal.mesas()[invite.mesaId];
    const chair = mesa?.chairs.find(c => c.chairId === invite.chairId);
    if (!mesa || !chair) throw new DomainError('INVALID_INPUT', 'Convite inválido ou expirado.');
    return { invite, mesa, chair };
  }

  private assertMesaOpen(mesa: MesaRecord): void {
    if (mesa.cancelled) throw new DomainError('INVALID_INPUT', 'Esta mesa foi cancelada.');
    if (this.now() >= mesa.expiresAt) throw new DomainError('INVALID_INPUT', 'Esta mesa expirou.');
  }

  /** Resolve o convite para a página pública. `code` ausente → metadados mínimos (fallback de digitação). */
  async resolveInvite(inviteId: string, code?: string): Promise<{ mesaCode: string; role: MesaChairRole; roleLabel: string; asset: string; network: string; networkLabel: string; status: 'PENDING' | 'USED' | 'REVOKED' | 'EXPIRED'; expiresAt: number; serverTime: number; codeValid: boolean }> {
    const { invite, mesa, chair } = await this.inviteOrThrow(inviteId);
    const now = this.now();
    const status = invite.status === 'PENDING' && (invite.expiresAt <= now || now >= mesa.expiresAt || mesa.cancelled) ? 'EXPIRED' : invite.status;
    const codeValid = !!code && hashesEqual(codeHashOf(inviteId, code), invite.codeHash);
    if (invite.status === 'PENDING' && status === 'PENDING') void this.audit('mesa.convite.validado', 'public', { mesaId: mesa.mesaId, inviteId, codePresent: !!code, codeValid });
    return { mesaCode: mesa.code, role: chair.role, roleLabel: CHAIR_ROLE_LABEL[chair.role], asset: chair.expectedAsset.symbol, network: mesa.network, networkLabel: getChain(mesa.network)?.displayName ?? mesa.network, status, expiresAt: invite.expiresAt, serverTime: now, codeValid };
  }

  /** Challenge de entrada — texto exibido INTEGRALMENTE ao usuário e assinado pela Verum Wallet. */
  async joinChallenge(inviteId: string, input: { code: string; firstName: string; network: AuthNetwork; address: string }): Promise<{ message: string; nonce: string; expiresAt: number }> {
    const { invite, mesa, chair } = await this.inviteOrThrow(inviteId);
    this.assertMesaOpen(mesa);
    if (invite.status !== 'PENDING' || invite.expiresAt <= this.now()) throw new DomainError('INVALID_INPUT', invite.status === 'USED' ? 'Este convite já foi utilizado.' : 'Convite inválido ou expirado.');
    if (!hashesEqual(codeHashOf(inviteId, input.code), invite.codeHash)) throw new DomainError('FORBIDDEN', 'Código do convite incorreto.');
    const firstName = input.firstName.trim();
    if (!FIRST_NAME_RE.test(firstName)) throw new DomainError('INVALID_INPUT', 'Informe seu primeiro nome (2 a 30 caracteres).');
    const address = input.address.trim();
    if (address.length < 8 || address.length > 120) throw new DomainError('INVALID_INPUT', 'Endereço de carteira inválido.');
    // Mesma wallet não pode ocupar duas cadeiras da mesma mesa.
    this.assertAddressFree(mesa, chair.chairId, address);
    const t = this.now();
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = t + CHALLENGE_TTL_MS;
    await this.d.store.insertNonce({ value: nonce, kind: 'challenge', dealId: null, revision: null, role: chair.role, subject: JSON.stringify({ k: 'mesa-join', inviteId, mesaId: mesa.mesaId, chairId: chair.chairId, network: input.network, address, firstName }), issuedAt: t, expiresAt, consumedAt: null });
    void this.audit('mesa.wallet.identificada', 'public', { mesaId: mesa.mesaId, chairId: chair.chairId, inviteId, network: input.network, address });
    return { message: this.challengeMessage(mesa, chair, firstName, address, input.network, nonce, expiresAt), nonce, expiresAt };
  }

  private challengeMessage(mesa: MesaRecord, chair: MesaChair, firstName: string, address: string, network: string, nonce: string, expiresAt: number): string {
    return [
      'Autorizar entrada na Mesa OTC',
      `Mesa: ${mesa.code} · Cadeira: ${CHAIR_ROLE_LABEL[chair.role]} · Nome: ${firstName}`,
      `Wallet: ${address} · Rede: ${network}`,
      `Nonce: ${nonce} · Expira: ${new Date(expiresAt).toISOString()}`,
    ].join('\n');
  }

  private assertAddressFree(mesa: MesaRecord, chairId: string, address: string): void {
    const addr = address.toLowerCase();
    for (const c of mesa.chairs) {
      if (c.chairId === chairId || !c.wallet) continue;
      const all = [c.wallet.address, ...(c.wallet.addresses ?? []).map(a => a.address)].map(a => a.toLowerCase());
      if (all.includes(addr)) throw new DomainError('VERSION_CONFLICT', 'Esta wallet já ocupa outra cadeira desta mesa.');
    }
  }

  private verifyBy(network: AuthNetwork, message: string, signature: string, address: string): Promise<boolean> | boolean {
    if (network === 'ethereum') return verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` }).catch(() => false);
    if (network === 'solana') return verifySolana(message, signature, address);
    if (network === 'tron') return verifyTron(message, signature, address);
    return verifyBitcoin(message, signature, address);
  }

  /** Join: verifica assinatura + nonce de uso único + consumo ATÔMICO do convite + vínculo da cadeira + sessão. */
  async joinMesa(inviteId: string, input: { code: string; firstName: string; network: AuthNetwork; address: string; nonce: string; signature: string; addresses?: WalletAddress[] }): Promise<{ token: string; mesaId: string; chairId: string; role: MesaChairRole }> {
    const { invite, mesa, chair } = await this.inviteOrThrow(inviteId);
    this.assertMesaOpen(mesa);
    if (!hashesEqual(codeHashOf(inviteId, input.code), invite.codeHash)) throw new DomainError('FORBIDDEN', 'Código do convite incorreto.');
    const t = this.now();
    const n = await this.d.store.getNonce(input.nonce);
    if (!n || n.kind !== 'challenge' || !n.subject) throw new DomainError('NONCE_INVALID', 'Desafio desconhecido. Recomece a conexão.');
    let sub: { k: string; inviteId: string; mesaId: string; chairId: string; network: AuthNetwork; address: string; firstName: string };
    try { sub = JSON.parse(n.subject) as typeof sub; } catch { throw new DomainError('NONCE_INVALID', 'Desafio inválido.'); }
    if (sub.k !== 'mesa-join' || sub.inviteId !== inviteId || sub.mesaId !== mesa.mesaId || sub.chairId !== chair.chairId) throw new DomainError('NONCE_INVALID', 'Desafio emitido para outro convite.');
    if (sub.network !== input.network || sub.address.toLowerCase() !== input.address.trim().toLowerCase() || sub.firstName !== input.firstName.trim()) throw new DomainError('NONCE_INVALID', 'Desafio emitido para outra carteira.');
    if (n.consumedAt !== null) throw new DomainError('NONCE_INVALID', 'Desafio já utilizado.');
    if (t >= n.expiresAt) throw new DomainError('SIGNATURE_EXPIRED', 'Desafio expirado. Recomece a conexão.');
    // Reconstrói a mensagem a partir do nonce persistido — o cliente não escolhe o que assina.
    const message = this.challengeMessage(mesa, chair, sub.firstName, sub.address, sub.network, n.value, n.expiresAt);
    const ok = await Promise.resolve(this.verifyBy(sub.network, message, input.signature, sub.address));
    if (!ok) { void this.audit('mesa.assinatura.rejeitada', 'public', { mesaId: mesa.mesaId, chairId: chair.chairId, inviteId, reason: 'challenge_invalido' }); throw new DomainError('SIGNATURE_INVALID', 'Assinatura do desafio inválida para a carteira informada.'); }
    if (!(await this.d.store.consumeNonce(n.value, t))) throw new DomainError('NONCE_INVALID', 'Desafio já utilizado.');
    // Revalida a unicidade da wallet imediatamente antes do consumo.
    this.assertAddressFree(mesa, chair.chairId, sub.address);
    // CONSUMO ATÔMICO: exatamente uma tentativa vence; a outra recebe a mensagem canônica.
    const consumed = await this.d.store.consumeMesaInvite(inviteId, { address: sub.address, name: sub.firstName }, t);
    if (!consumed) {
      const cur = await this.d.store.getMesaInvite(inviteId);
      // Reparo idempotente: a MESMA wallet venceu antes (escrita do JSONB pode ter se perdido em outra instância).
      if (!(cur && cur.status === 'USED' && cur.usedByAddress?.toLowerCase() === sub.address.toLowerCase())) {
        throw new DomainError('VERSION_CONFLICT', 'Este convite já foi utilizado por outra wallet.');
      }
    }
    chair.wallet = this.d.portal.walletLink(sub.address, sub.network, input.addresses);
    chair.firstName = sub.firstName;
    chair.connectedAt = t;
    this.d.portal.persistMesas();
    void this.audit('mesa.wallet.posse_confirmada', 'public', { mesaId: mesa.mesaId, chairId: chair.chairId, role: chair.role, network: sub.network, address: sub.address });
    void this.audit('mesa.convite.consumido', 'public', { mesaId: mesa.mesaId, chairId: chair.chairId, inviteId });
    const session: Session = { sub: `mesa:${mesa.mesaId}:${chair.chairId}`, network: sub.network as Network, chainId: '', address: sub.address, keyScheme: NETWORK_KEY_SCHEME[sub.network as Network], role: 'participant', iat: t, exp: t + 24 * 3600_000, mesa: { mesaId: mesa.mesaId, chairId: chair.chairId, role: chair.role, firstName: sub.firstName } };
    return { token: this.d.auth.sign(session), mesaId: mesa.mesaId, chairId: chair.chairId, role: chair.role };
  }

  /* ---------- configuração e aprovação (admin-only) ---------- */

  updateConfig(portalToken: string | undefined, mesaId: string, patch: Partial<MesaOperationConfig>): MesaOperationConfig {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    this.assertMesaOpen(mesa);
    if (mesa.approvedAt) throw new DomainError('VERSION_CONFLICT', 'Operação já aprovada — configuração congelada.');
    const cur: MesaOperationConfig = mesa.config ?? { discountBps: 0, commissionBps: 0 };
    const next: MesaOperationConfig = { ...cur, ...patch };
    if (next.discountBps < 0 || next.discountBps > 2000) throw new DomainError('INVALID_INPUT', 'Deságio fora do intervalo permitido');
    if (next.commissionBps < 0 || next.commissionBps > 5000) throw new DomainError('INVALID_INPUT', 'Comissão fora do intervalo permitido');
    if (next.amountInBase !== undefined && !/^[1-9][0-9]*$/.test(next.amountInBase)) throw new DomainError('INVALID_INPUT', 'Quantidade inválida');
    if (next.buyerAmountInBase !== undefined && !/^[1-9][0-9]*$/.test(next.buyerAmountInBase)) throw new DomainError('INVALID_INPUT', 'Quantidade do comprador inválida');
    mesa.config = next;
    this.d.portal.persistMesas();
    void this.audit('mesa.operacao.configurada', pm.id, { mesaId, config: { ...next, notes: undefined } });
    return next;
  }

  /** Congela os termos na aprovação (validações de saldo/gás acontecem na rota, com motivos nominais). */
  markApproved(mesa: MesaRecord, pmId: string): void {
    mesa.approvedAt = this.now();
    mesa.termsHash = sha256Hex(canonicalize({ config: mesa.config ?? null, network: mesa.network, chairs: mesa.chairs.map(c => ({ role: c.role, address: c.wallet?.address ?? null, asset: c.expectedAsset })) }));
    this.d.portal.persistMesas();
    void this.audit('mesa.operacao.aprovada', pmId, { mesaId: mesa.mesaId, termsHash: mesa.termsHash });
  }

  attachDeal(mesa: MesaRecord, dealId: string): void {
    mesa.dealId = dealId;
    mesa.dealIds = [...mesa.dealIds.filter(id => id !== dealId), dealId].slice(-50);
    this.d.portal.persistMesas();
  }

  /**
   * Trava de irrevogabilidade: assim que a leg de CONTRATO é financiada (token trancado no escrow)
   * ou a coleta de assinaturas termina, o processo roda sozinho até a extração da preimage (claim)
   * ou a expiração do timelock (refund) — nenhum usuário cancela mais nada.
   */
  isIrreversible(deal: Deal | null): boolean {
    if (!deal) return false;
    if (['FULLY_SIGNED', 'SETTLEMENT_VALIDATION', 'SETTLING', 'SETTLED'].includes(deal.state)) return true;
    return deal.participants.some(p => p.fundingRequired && p.funding === 'FINAL');
  }
  async irreversibleOf(mesa: MesaRecord): Promise<boolean> {
    const deal = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    return this.isIrreversible(deal);
  }

  async cancelMesa(portalToken: string | undefined, mesaId: string, reason: string): Promise<void> {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    if (mesa.cancelled) return;
    if (await this.irreversibleOf(mesa)) throw new DomainError('VERSION_CONFLICT', 'Operação irreversível: fundos já trancados no escrow — o contrato segue até a liquidação (preimage) ou o reembolso após o timelock.');
    mesa.cancelled = { at: this.now(), reason: reason.trim() || 'Cancelada pelo Pay Master' };
    this.d.portal.persistMesas();
    void this.audit('mesa.cancelada', pm.id, { mesaId, reason: mesa.cancelled.reason });
  }

  /* ---------- DTO recortado por papel (aplicado no BACKEND) ---------- */

  private shortAddr(a: string): string { return a.length > 12 ? `${a.slice(0, 7)}…${a.slice(-3)}` : a; }

  async mesaViewFor(mesa: MesaRecord, viewer: { kind: 'admin' } | { kind: 'participant'; chairId: string }): Promise<Record<string, unknown>> {
    const now = this.now();
    const invites = await this.d.store.listMesaInvites(mesa.mesaId);
    const deal = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    const status = deriveMesaStatus(mesa, invites, deal, now);
    const base = {
      mesaId: mesa.mesaId, code: mesa.code, operationCode: mesa.operationCode ?? null, network: mesa.network, networkLabel: getChain(mesa.network)?.displayName ?? mesa.network,
      settlement: deriveSettlementPlan(mesa.chairs),
      status, createdAt: mesa.createdAt, expiresAt: mesa.expiresAt, serverTime: now,
      approvedAt: mesa.approvedAt ?? null, termsHash: mesa.termsHash ?? null,
      // Trava de irrevogabilidade exposta ao frontend: canCancel=false → UI remove "Cancelar mesa".
      irreversible: this.isIrreversible(deal), canCancel: !mesa.cancelled && !this.isIrreversible(deal),
      deal: deal ? { id: deal.id, state: deal.state, requiredSignatures: deal.requiredSignatures, validSignatures: deal.validSignatures, turnRole: deal.turnRole ?? null, turnExpiresAt: deal.turnExpiresAt ?? null, expiresAt: deal.expiresAt, signed: deal.signatures.filter(s => s.status === 'valid' && s.revision === deal.revision).map(s => s.role) } : null,
    };
    if (viewer.kind === 'admin') {
      const invByChair = new Map(invites.filter(i => i.status === 'PENDING' && i.expiresAt > now).map(i => [i.chairId, i]));
      return {
        ...base, label: mesa.label ?? null, config: mesa.config ?? null, approvals: mesa.approvals,
        chairs: mesa.chairs.map(c => ({
          chairId: c.chairId, role: c.role, roleLabel: CHAIR_ROLE_LABEL[c.role], label: c.label ?? null,
          expectedAsset: c.expectedAsset, firstName: c.firstName ?? null, connectedAt: c.connectedAt ?? null,
          wallet: c.wallet ? { address: c.wallet.address, network: c.wallet.network, multichain: c.wallet.multichain ?? false } : null,
          invite: invByChair.has(c.chairId) ? { inviteId: (invByChair.get(c.chairId) as MesaInviteRow).inviteId, expiresAt: (invByChair.get(c.chairId) as MesaInviteRow).expiresAt } : null,
        })),
        invites: invites.map(i => ({ inviteId: i.inviteId, chairId: i.chairId, status: i.status === 'PENDING' && i.expiresAt <= now ? 'EXPIRED' : i.status, usedByName: i.usedByName, usedAt: i.usedAt, expiresAt: i.expiresAt })),
        cancelled: mesa.cancelled ?? null,
      };
    }
    // Participante: SOMENTE o pertinente — nada de links/códigos/rótulos internos/aprovações/notas.
    const me = mesa.chairs.find(c => c.chairId === viewer.chairId);
    return {
      ...base,
      viewer: me ? { chairId: me.chairId, role: me.role, roleLabel: CHAIR_ROLE_LABEL[me.role], firstName: me.firstName ?? null, wallet: me.wallet ? this.shortAddr(me.wallet.address) : null, asset: me.expectedAsset.symbol } : null,
      config: mesa.config ? { amountInBase: mesa.config.amountInBase ?? null, discountBps: mesa.config.discountBps, commissionBps: mesa.config.commissionBps, commissionPayer: mesa.config.commissionPayer ?? null } : null,
      chairs: mesa.chairs.map(c => ({
        role: c.role, roleLabel: CHAIR_ROLE_LABEL[c.role],
        firstName: c.firstName ?? null,
        wallet: c.wallet ? this.shortAddr(c.wallet.address) : null,
        asset: c.expectedAsset.symbol,
        connected: !!c.wallet,
        isMe: c.chairId === viewer.chairId,
      })),
    };
  }
}
