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
import { INVITE_TTL_MS, CHALLENGE_TTL_MS, INVITE_CODE_ALPHABET } from '../domain/constants.js';
import type { MesaInviteRow, Store } from '../db/repository.js';
import type { PortalService, WalletAddress, PayMaster } from '../portal/portal.js';
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
  /** Embrulho canônico da moeda nativa (SOL→wSOL, ETH→WETH) quando o caminho de liquidação é
   *  só-token: recebe a rede da cadeira e a da CONTRAPARTE depositante (SELLER↔BUYER) e decide —
   *  ex.: SOL fica nativo na rota cross-chain (HTLC nativo) e vira wSOL só no escrow direto
   *  Solana↔Solana. Símbolo exibido continua o nativo. null/ausente = sem embrulho. */
  nativeWrapOf?: (network: string, counterpartyNetwork: string | null) => { contractOrMint: string; decimals: number } | null;
  /** true quando a perna Bitcoin roda no SIMULADOR (preview/dev) — a UI exibe "BTC simulado". */
  btcSimulated?: () => boolean;
  /** true quando o escrow Tron configurado tem perna HTLC (V2) — libera o par BTC nativo ↔ Tron. */
  tronHashlock?: () => boolean;
}

export interface CreateMesaChairInput { role: MesaChairRole; expectedAsset: ChairAsset; label?: string }
/** `network` é opcional (v4): quando ausente, deriva da cadeira do VENDEDOR — quem manda nas pernas são as redes de cada lado. */
export interface CreateMesaInput { label?: string; network?: string; chairs: CreateMesaChairInput[] }

export class MesaService {
  private readonly now: () => number;
  constructor(private readonly d: MesaServiceDeps) { this.now = d.now ?? (() => Date.now()); }

  /** Relógio do serviço (injetável nos testes) — autoridade dos timers também nas rotas. */
  nowMs(): number { return this.now(); }

  private audit(category: string, actorId: string, payload: Record<string, unknown>): Promise<void> {
    return this.d.audit.append({ actorType: 'user', actorId, category, dealId: null, payload }).then(() => undefined);
  }

  /* ---------- criação e leitura (admin) ---------- */

  /** Par NÃO suportado: BTC NATIVO ↔ Tron. O swap de BTC usa HTLC e exige que a OUTRA perna revele o
   *  segredo (hashlock) na liquidação; o contrato da Tron não tem hashlock. (BTC funciona com Ethereum
   *  ou Solana.) Bloqueia na criação e na troca de ativo — não só na aprovação. */
  private assertSwappablePair(chairs: { role: MesaChairRole; expectedAsset: ChairAsset }[]): void {
    const seller = chairs.find(c => c.role === 'SELLER')?.expectedAsset;
    const buyer = chairs.find(c => c.role === 'BUYER')?.expectedAsset;
    if (!seller || !buyer) return;
    const isBtcNative = (a: ChairAsset) => a.network === 'bitcoin' && a.contractOrMint == null;
    const isTron = (a: ChairAsset) => a.network === 'tron';
    // Escrow Tron V2 (hashlock) configurado libera o par: o settleV2 revela a preimage que
    // destrava o HTLC do BTC — mesma atomicidade do BTC↔Ethereum.
    if (this.d.tronHashlock?.()) return;
    if ((isBtcNative(seller) && isTron(buyer)) || (isTron(seller) && isBtcNative(buyer))) {
      throw new DomainError('INVALID_INPUT', 'BTC nativo não pode ser trocado com a rede Tron: o swap de BTC usa HTLC e exige que a outra perna revele o segredo (hashlock), que o contrato da Tron não tem. Use BTC com Ethereum ou Solana — ou troque a rede de uma das pernas.');
    }
  }

  createMesa(portalToken: string | undefined, input: CreateMesaInput): MesaRecord {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const roles = input.chairs.map(c => c.role);
    // Escrow dinâmico (v4): 2 cadeiras (bilateral), 3 (com Pay Master) ou 4 (dois Pay Masters).
    if (input.chairs.length < 2 || input.chairs.length > 4) throw new DomainError('INVALID_INPUT', 'A mesa precisa de 2 a 4 cadeiras');
    if (new Set(roles).size !== roles.length) throw new DomainError('INVALID_INPUT', 'Cada função aparece no máximo uma vez');
    for (const r of ['SELLER', 'BUYER'] as MesaChairRole[]) if (!roles.includes(r)) throw new DomainError('INVALID_INPUT', `A mesa precisa da cadeira ${CHAIR_ROLE_LABEL[r]}`);
    if (roles.includes('PAYMASTER_2') && !roles.includes('PAYMASTER_1')) throw new DomainError('INVALID_INPUT', 'Pay Master 2 exige a cadeira Pay Master 1');
    // "Rede principal" DERIVADA (v4): rede do lado vendedor (fallback: primeira cadeira). O campo
    // saiu do wizard — quem decide a liquidação são as redes de CADA perna; este valor sobrevive
    // só como rótulo/fallback e por compatibilidade (termsHash, convites).
    const network = input.network || input.chairs.find(c => c.role === 'SELLER')?.expectedAsset.network || input.chairs[0]?.expectedAsset.network;
    if (!network || typeof network !== 'string') throw new DomainError('INVALID_INPUT', 'Rede da mesa indeterminada — informe a rede de cada lado');
    const t = this.now();
    const chairs: MesaChair[] = input.chairs.map(c => {
      const asset = c.expectedAsset;
      if (!asset || typeof asset.symbol !== 'string' || typeof asset.decimals !== 'number') throw new DomainError('INVALID_INPUT', `Ativo esperado inválido na cadeira ${CHAIR_ROLE_LABEL[c.role]}`);
      const net = asset.network || network;
      // Nativo com embrulho canônico → vira o token por baixo (wSOL/WETH) QUANDO a rota exige
      // token; o usuário continua vendo "SOL"/"ETH" e a tx de depósito embrulha sozinha. A
      // contraparte depositante (SELLER↔BUYER) decide a rota — PMs não depositam.
      const other = c.role === 'SELLER' ? input.chairs.find(x => x.role === 'BUYER') : c.role === 'BUYER' ? input.chairs.find(x => x.role === 'SELLER') : null;
      const otherNet = other ? (other.expectedAsset?.network || network || null) : null;
      const wrap = asset.contractOrMint == null ? this.d.nativeWrapOf?.(net, otherNet) ?? null : null;
      const chair: MesaChair = { chairId: 'ch_' + randomUUID(), role: c.role, expectedAsset: wrap ? { network: net, contractOrMint: wrap.contractOrMint, decimals: wrap.decimals, symbol: asset.symbol } : { network: net, contractOrMint: asset.contractOrMint ?? null, decimals: asset.decimals, symbol: asset.symbol }, label: c.label?.trim() || undefined, wallet: null };
      // A cadeira Pay Master 1 é do próprio admin — já conectada com a wallet dele (quando houver).
      if (c.role === 'PAYMASTER_1' && pm.wallet) { chair.wallet = pm.wallet; chair.firstName = pm.name.split(/\s+/)[0]; chair.connectedAt = t; }
      return chair;
    });
    this.assertSwappablePair(chairs); // BTC nativo ↔ Tron não é swappable (sem hashlock na Tron)
    const mesa: MesaRecord = { mesaId: 'mesa_' + randomUUID(), payMasterId: pm.id, code: this.d.portal.newMesaCode(), operationCode: `OP-${newInviteCode()}`, label: input.label?.trim() || undefined, network, chairs, approvals: {}, dealId: null, dealIds: [], createdAt: t, expiresAt: null };
    this.d.portal.mesas()[mesa.mesaId] = mesa;
    this.d.portal.persistMesas();
    void this.audit('mesa.criada', pm.id, { mesaId: mesa.mesaId, code: mesa.code, network: mesa.network, chairs: chairs.map(c => ({ chairId: c.chairId, role: c.role })) });
    return mesa;
  }

  /** Re-aplica o embrulho canônico (ETH→WETH) em cadeiras NATIVAS de mesas antigas: mesa criada num
   *  ambiente SEM o escrow EVM configurado (ex.: preview antes das envs) não ganhou o wrap na criação
   *  e o approve morria com "escrow Verum é só-token". Idempotente — espelha a lógica da criação. */
  healNativeWraps(mesa: MesaRecord): void {
    let changed = false;
    for (const c of mesa.chairs) {
      if (c.expectedAsset.contractOrMint != null) continue;
      const other = c.role === 'SELLER' ? mesa.chairs.find(x => x.role === 'BUYER') : c.role === 'BUYER' ? mesa.chairs.find(x => x.role === 'SELLER') : null;
      const wrap = this.d.nativeWrapOf?.(c.expectedAsset.network, other?.expectedAsset.network ?? null) ?? null;
      if (!wrap) continue;
      c.expectedAsset = { ...c.expectedAsset, contractOrMint: wrap.contractOrMint, decimals: wrap.decimals };
      changed = true;
    }
    if (changed) this.d.portal.persistMesas();
  }

  /** Rótulo de redes da mesa (v4): lados na mesma rede → nome dela; redes distintas → "A ↔ B". */
  networksLabel(mesa: MesaRecord): string {
    const name = (n?: string) => (n ? getChain(n)?.displayName ?? n : null);
    const s = name(mesa.chairs.find(c => c.role === 'SELLER')?.expectedAsset.network);
    const b = name(mesa.chairs.find(c => c.role === 'BUYER')?.expectedAsset.network);
    if (s && b && s !== b) return `${s} ↔ ${b}`;
    return s ?? b ?? getChain(mesa.network)?.displayName ?? mesa.network;
  }

  /** Mesa do admin (lança FORBIDDEN se não for o dono). */
  private mesaOf(pmId: string, mesaId: string): MesaRecord {
    const mesa = this.d.portal.mesas()[mesaId];
    if (!mesa || mesa.payMasterId !== pmId) throw new DomainError('FORBIDDEN', 'Mesa não encontrada para este Pay Master');
    return mesa;
  }
  /** Mesa por id (participante já autorizado pela sessão). */
  mesaById(mesaId: string): MesaRecord | null { return this.d.portal.mesas()[mesaId] ?? null; }

  /** Endereços (lowercase) da carteira do PM — primária + multichain. Usado p/ achar mesas onde ele participa. */
  private pmWalletAddresses(pm: PayMaster): Set<string> {
    const w = pm.wallet; if (!w) return new Set();
    return new Set([w.address, ...(w.addresses ?? []).map(a => a.address)].filter(Boolean).map(a => a.toLowerCase()));
  }
  /** A carteira do PM ocupa alguma cadeira desta mesa? (participante, mesmo sem ser o dono). */
  private pmIsChair(pm: PayMaster, mesa: MesaRecord): boolean {
    const mine = this.pmWalletAddresses(pm); if (!mine.size) return false;
    return mesa.chairs.some(c => c.wallet && [c.wallet.address, ...(c.wallet.addresses ?? []).map(a => a.address)].some(a => mine.has(a.toLowerCase())));
  }

  async listMesas(portalToken: string | undefined): Promise<{ mesaId: string; code: string; operationCode: string | null; label?: string; network: string; networkLabel: string; status: MesaStatus; dealId: string | null; owner: boolean; myRole: MesaChairRole | null; chairs: { role: MesaChairRole; firstName: string | null; connected: boolean }[]; amount: string | null; createdAt: number; expiresAt: number | null }[]> {
    const pm = this.d.portal.requirePayMaster(portalToken, false);
    // DONO (criou) + PARTICIPANDO (carteira ocupa uma cadeira em mesa de terceiro) — p/ não "sumir" do painel.
    const mine = this.pmWalletAddresses(pm);
    const myRoleIn = (m: MesaRecord): MesaChairRole | null => m.chairs.find(c => c.wallet && [c.wallet.address, ...(c.wallet.addresses ?? []).map(a => a.address)].some(a => mine.has(a.toLowerCase())))?.role ?? null;
    const mesas = Object.values(this.d.portal.mesas()).filter(m => m.payMasterId === pm.id || this.pmIsChair(pm, m)).sort((a, b) => b.createdAt - a.createdAt);
    const out = [];
    for (const m of mesas) {
      const status = await this.statusOf(m);
      const owner = m.payMasterId === pm.id;
      out.push({ mesaId: m.mesaId, code: m.code, operationCode: m.operationCode ?? null, label: m.label, network: m.network, networkLabel: this.networksLabel(m), status, dealId: m.dealId ?? null, owner, myRole: owner ? null : myRoleIn(m), chairs: m.chairs.map(c => ({ role: c.role, firstName: c.firstName ?? null, connected: !!c.wallet })), amount: m.config?.amountInBase ?? null, createdAt: m.createdAt, expiresAt: m.expiresAt });
    }
    return out;
  }

  async statusOf(mesa: MesaRecord): Promise<MesaStatus> {
    const invites = await this.d.store.listMesaInvites(mesa.mesaId);
    const deal = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    return deriveMesaStatus(mesa, invites, deal, this.now());
  }

  /* ---------- convites por cadeira ---------- */

  /** `baseUrl` opcional: a rota passa o host REAL da requisição (deploy/local) — o default de
   *  configuração vira só fallback, nunca mais um link para domínio morto. */
  async createChairInvite(portalToken: string | undefined, mesaId: string, chairId: string, baseUrl?: string): Promise<{ inviteId: string; code: string; link: string; message: string; expiresAt: number; role: MesaChairRole }> {
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
    const expiresAt = mesa.expiresAt != null ? Math.min(t + INVITE_TTL_MS, mesa.expiresAt) : t + INVITE_TTL_MS; // mesa sem expiração → convite vive o INVITE_TTL cheio
    const row: MesaInviteRow = { inviteId, mesaId, chairId, codeHash: codeHashOf(inviteId, code), codePrefix: normalizeCode(code).slice(0, 4), status: 'PENDING', usedByAddress: null, usedByName: null, usedAt: null, createdAt: t, expiresAt };
    await this.d.store.insertMesaInvite(row);
    void this.audit('mesa.convite.gerado', pm.id, { mesaId, chairId, inviteId, role: chair.role });
    const link = `${baseUrl ?? this.d.baseUrl}/otc/convite/${encodeURIComponent(inviteId)}?c=${encodeURIComponent(code)}`;
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
    if (mesa.expiresAt != null && this.now() >= mesa.expiresAt) throw new DomainError('INVALID_INPUT', 'Esta mesa expirou.');
  }

  /** Resolve o convite para a página pública. `code` ausente → metadados mínimos (fallback de digitação). */
  async resolveInvite(inviteId: string, code?: string): Promise<{ mesaCode: string; role: MesaChairRole; roleLabel: string; asset: string; network: string; networkLabel: string; status: 'PENDING' | 'USED' | 'REVOKED' | 'EXPIRED'; expiresAt: number; serverTime: number; codeValid: boolean }> {
    const { invite, mesa, chair } = await this.inviteOrThrow(inviteId);
    const now = this.now();
    const status = invite.status === 'PENDING' && (invite.expiresAt <= now || (mesa.expiresAt != null && now >= mesa.expiresAt) || mesa.cancelled) ? 'EXPIRED' : invite.status;
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

  /**
   * Conexão da cadeira SEM assinatura de mensagem — a posse é provada pela CONEXÃO da Verum Wallet
   * (a carteira só devolve o endereço real do usuário), exatamente como o Pay Master 1/admin conecta
   * em /v1/portal/wallet/connect. Usado porque o signMessage do provider nativo da Verum não entrega
   * a assinatura no dapp-browser. Controle de acesso = o código secreto do convite. Consumo atômico.
   */
  async connectMesa(inviteId: string, input: { code: string; firstName: string; network: AuthNetwork; address: string; addresses?: WalletAddress[] }): Promise<{ token: string; mesaId: string; chairId: string; role: MesaChairRole }> {
    const { invite, mesa, chair } = await this.inviteOrThrow(inviteId);
    this.assertMesaOpen(mesa);
    if (invite.status !== 'PENDING' || invite.expiresAt <= this.now()) throw new DomainError('INVALID_INPUT', invite.status === 'USED' ? 'Este convite já foi utilizado.' : 'Convite inválido ou expirado.');
    if (!hashesEqual(codeHashOf(inviteId, input.code), invite.codeHash)) throw new DomainError('FORBIDDEN', 'Código do convite incorreto.');
    const firstName = input.firstName.trim();
    if (!FIRST_NAME_RE.test(firstName)) throw new DomainError('INVALID_INPUT', 'Informe seu primeiro nome (2 a 30 caracteres).');
    const address = input.address.trim();
    if (address.length < 8 || address.length > 120) throw new DomainError('INVALID_INPUT', 'Endereço de carteira inválido.');
    const t = this.now();
    this.assertAddressFree(mesa, chair.chairId, address);
    // CONSUMO ATÔMICO do convite — exatamente uma conexão vence (reparo idempotente p/ a mesma wallet).
    const consumed = await this.d.store.consumeMesaInvite(inviteId, { address, name: firstName }, t);
    if (!consumed) {
      const cur = await this.d.store.getMesaInvite(inviteId);
      if (!(cur && cur.status === 'USED' && cur.usedByAddress?.toLowerCase() === address.toLowerCase())) {
        throw new DomainError('VERSION_CONFLICT', 'Este convite já foi utilizado por outra wallet.');
      }
    }
    chair.wallet = this.d.portal.walletLink(address, input.network, input.addresses);
    chair.firstName = firstName;
    chair.connectedAt = t;
    this.d.portal.persistMesas();
    void this.audit('mesa.wallet.conectada', 'public', { mesaId: mesa.mesaId, chairId: chair.chairId, role: chair.role, network: input.network, address, proof: 'connect' });
    void this.audit('mesa.convite.consumido', 'public', { mesaId: mesa.mesaId, chairId: chair.chairId, inviteId });
    const session: Session = { sub: `mesa:${mesa.mesaId}:${chair.chairId}`, network: input.network as Network, chainId: '', address, keyScheme: NETWORK_KEY_SCHEME[input.network as Network], role: 'participant', iat: t, exp: t + 24 * 3600_000, mesa: { mesaId: mesa.mesaId, chairId: chair.chairId, role: chair.role, firstName } };
    return { token: this.d.auth.sign(session), mesaId: mesa.mesaId, chairId: chair.chairId, role: chair.role };
  }

  /** Encontra a cadeira cuja carteira (primária OU qualquer endereço multichain) bate com `address`. */
  private chairByWallet(mesa: MesaRecord, address: string): MesaChair | undefined {
    const addr = address.trim().toLowerCase();
    return mesa.chairs.find(c => c.wallet && [c.wallet.address, ...(c.wallet.addresses ?? []).map(a => a.address)].map(a => a.toLowerCase()).includes(addr));
  }

  /**
   * REENTRADA (somente leitura) de uma carteira JÁ vinculada a uma cadeira — sem novo convite.
   * O dono reconecta a Verum Wallet e assina um desafio provando posse da MESMA carteira; recebe um
   * token de participante novo. Não altera nada da mesa (o token de participante não muta config).
   */
  async reenterChallenge(mesaId: string, input: { network: AuthNetwork; address: string; addresses?: WalletAddress[] }): Promise<{ message: string; nonce: string; expiresAt: number; network: AuthNetwork; address: string }> {
    const mesa = this.mesaById(mesaId);
    if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada.');
    // O cliente pode identificar a cadeira por QUALQUER endereço multichain que a carteira exponha
    // (chairByWallet casa a lista toda capturada no join) — tolerante a quem não tem a Solana no topo.
    const candidates = [input.address, ...((input.addresses ?? []).map(a => a.address))].filter(Boolean);
    let chair: MesaChair | undefined; for (const a of candidates) { chair = this.chairByWallet(mesa, a); if (chair) break; }
    if (!chair || !chair.wallet) throw new DomainError('FORBIDDEN', 'Esta carteira não está conectada a nenhuma cadeira desta mesa.');
    // A prova de posse PRECISA casar com o PARTICIPANTE do deal (mesma rede/endereço) — o backend
    // identifica o signatário PELO ENDEREÇO, então a sessão reentrante tem de nascer no mesmo endereço
    // do papel no deal. Em pernas cross-chain esse endereço pode estar numa rede DIFERENTE da "rede da
    // mesa" (ex.: Vendedor BTC assina na rede bitcoin, embora o escrow/mesa seja EVM/Solana) — usar a
    // rede da mesa + endereço primário da cadeira dava NOT_PARTICIPANT. Usa o participante REAL do deal
    // ativo quando houver; sem deal (reentrada só-leitura antes da operação), cai no endereço primário.
    const dealId = mesa.dealId ?? (mesa.dealIds && mesa.dealIds.length ? mesa.dealIds[mesa.dealIds.length - 1] : null);
    const deal = dealId ? await this.d.getDeal(dealId).catch(() => null) : null;
    const dp = deal?.participants.find(p => (p.role as string) === (chair.role as string));
    // SEM o participante do deal (deal ausente/não linkado), usa a REDE DO ATIVO da cadeira (ex.:
    // Vendedor BTC → bitcoin) e o endereço da carteira NAQUELA rede — NUNCA o primário (Solana), que
    // fazia a reentrada assinar na chave ERRADA (ed25519 Solana) e cair em NOT_PARTICIPANT em loop.
    // A rede da mesa fica só como último recurso (reentrada só-leitura antes de existir operação).
    const legNet = chair.expectedAsset.network;
    const legAddr = (chair.wallet.addresses ?? []).find(a => a.network === legNet)?.address;
    const network = authNetworkFor((dp?.network as string | undefined) ?? legNet ?? mesa.network);
    const address = dp?.address ?? legAddr ?? chair.wallet.address;
    const t = this.now();
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = t + CHALLENGE_TTL_MS;
    await this.d.store.insertNonce({ value: nonce, kind: 'challenge', dealId: null, revision: null, role: chair.role, subject: JSON.stringify({ k: 'mesa-reenter', mesaId, chairId: chair.chairId, network, address }), issuedAt: t, expiresAt, consumedAt: null });
    void this.audit('mesa.reentrada.desafio', 'public', { mesaId, chairId: chair.chairId, network, address });
    return { message: this.challengeMessage(mesa, chair, chair.firstName ?? 'participante', address, network, nonce, expiresAt), nonce, expiresAt, network, address };
  }

  async reenterMesa(mesaId: string, input: { network: AuthNetwork; address: string; nonce: string; signature: string }): Promise<{ token: string; mesaId: string; chairId: string; role: MesaChairRole }> {
    const mesa = this.mesaById(mesaId);
    if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada.');
    const t = this.now();
    const n = await this.d.store.getNonce(input.nonce);
    if (!n || n.kind !== 'challenge' || !n.subject) throw new DomainError('NONCE_INVALID', 'Desafio desconhecido. Recomece a conexão.');
    let sub: { k: string; mesaId: string; chairId: string; network: AuthNetwork; address: string };
    try { sub = JSON.parse(n.subject) as typeof sub; } catch { throw new DomainError('NONCE_INVALID', 'Desafio inválido.'); }
    if (sub.k !== 'mesa-reenter' || sub.mesaId !== mesaId) throw new DomainError('NONCE_INVALID', 'Desafio emitido para outra mesa.');
    if (sub.network !== input.network || sub.address.toLowerCase() !== input.address.trim().toLowerCase()) throw new DomainError('NONCE_INVALID', 'Desafio emitido para outra carteira.');
    if (n.consumedAt !== null) throw new DomainError('NONCE_INVALID', 'Desafio já utilizado.');
    if (t >= n.expiresAt) throw new DomainError('SIGNATURE_EXPIRED', 'Desafio expirado. Recomece a conexão.');
    const chair = mesa.chairs.find(c => c.chairId === sub.chairId);
    if (!chair || !chair.wallet || !this.chairByWallet(mesa, sub.address) || this.chairByWallet(mesa, sub.address)!.chairId !== chair.chairId) throw new DomainError('FORBIDDEN', 'Carteira não pertence a esta cadeira.');
    const message = this.challengeMessage(mesa, chair, chair.firstName ?? 'participante', sub.address, sub.network, n.value, n.expiresAt);
    const ok = await Promise.resolve(this.verifyBy(sub.network, message, input.signature, sub.address));
    if (!ok) { void this.audit('mesa.reentrada.rejeitada', 'public', { mesaId, chairId: chair.chairId, reason: 'assinatura_invalida' }); throw new DomainError('SIGNATURE_INVALID', 'Assinatura do desafio inválida para a carteira informada.'); }
    if (!(await this.d.store.consumeNonce(n.value, t))) throw new DomainError('NONCE_INVALID', 'Desafio já utilizado.');
    void this.audit('mesa.reentrada.ok', 'public', { mesaId, chairId: chair.chairId, role: chair.role, network: sub.network, address: sub.address });
    const session: Session = { sub: `mesa:${mesa.mesaId}:${chair.chairId}`, network: sub.network as Network, chainId: '', address: sub.address, keyScheme: NETWORK_KEY_SCHEME[sub.network as Network], role: 'participant', iat: t, exp: t + 24 * 3600_000, mesa: { mesaId: mesa.mesaId, chairId: chair.chairId, role: chair.role, firstName: chair.firstName ?? '' } };
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

  /** Troca o ATIVO esperado de uma cadeira (antes de aprovar). A rede da mesa segue o lado vendedor;
   *  se os decimais mudam, a quantidade daquele lado é limpa (estava em unidades-base do ativo antigo). */
  updateChairAsset(portalToken: string | undefined, mesaId: string, chairId: string, asset: ChairAsset): MesaRecord {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    this.assertMesaOpen(mesa);
    if (mesa.approvedAt) throw new DomainError('VERSION_CONFLICT', 'Operação já aprovada — ativo congelado. Reabra para editar.');
    const chair = mesa.chairs.find(c => c.chairId === chairId);
    if (!chair) throw new DomainError('INVALID_INPUT', 'Cadeira não encontrada.');
    if (!asset || typeof asset.symbol !== 'string' || typeof asset.decimals !== 'number' || !asset.network) throw new DomainError('INVALID_INPUT', 'Ativo inválido.');
    const prevDecimals = chair.expectedAsset.decimals;
    const nextAsset: ChairAsset = { network: asset.network, contractOrMint: asset.contractOrMint ?? null, decimals: asset.decimals, symbol: asset.symbol };
    // Valida ANTES de mutar: BTC nativo ↔ Tron não é swappable (sem hashlock na Tron).
    this.assertSwappablePair(mesa.chairs.map(c => c.chairId === chairId ? { role: c.role, expectedAsset: nextAsset } : { role: c.role, expectedAsset: c.expectedAsset }));
    chair.expectedAsset = nextAsset;
    // Rede da mesa (rótulo/fallback) deriva do lado VENDEDOR.
    if (chair.role === 'SELLER') mesa.network = asset.network;
    // Decimais mudaram → a quantidade daquele lado não faz mais sentido (base do ativo anterior).
    if (mesa.config && asset.decimals !== prevDecimals) {
      if (chair.role === 'SELLER') delete mesa.config.amountInBase;
      if (chair.role === 'BUYER') delete mesa.config.buyerAmountInBase;
    }
    this.d.portal.persistMesas();
    void this.audit('mesa.cadeira.ativo', pm.id, { mesaId, chairId, role: chair.role, asset: chair.expectedAsset });
    return mesa;
  }

  /**
   * Reabre uma mesa APROVADA (mas ainda NÃO irreversível) para edição da configuração: descarta a
   * operação ativa — o que INVALIDA as assinaturas já feitas — e remove approvedAt/termsHash, deixando
   * a config editável de novo. O admin edita e reaprova (gera uma nova operação; todos reassinam).
   * Bloqueada quando a operação já é irreversível (fundos trancados no escrow / já totalmente assinada).
   */
  async reopenForEdit(portalToken: string | undefined, mesaId: string): Promise<void> {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    this.assertMesaOpen(mesa);
    if (!mesa.approvedAt) return; // já editável — nada a reabrir
    const deal = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    if (this.isIrreversible(deal)) throw new DomainError('VERSION_CONFLICT', 'Operação irreversível: fundos já trancados (ou totalmente assinada) — não é possível reabrir para edição.');
    // Descarta a operação ativa (assinaturas invalidadas) e volta a mesa ao estado editável.
    if (mesa.dealId) mesa.dealIds = (mesa.dealIds ?? []).filter(id => id !== mesa.dealId);
    mesa.dealId = null;
    mesa.approvedAt = undefined;
    mesa.termsHash = undefined;
    this.d.portal.persistMesas();
    void this.audit('mesa.operacao.reaberta', pm.id, { mesaId, discardedDealId: deal?.id ?? null });
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

  /** Operação em liquidação/liquidada — não pode ser removida da lista (removê-la esconderia um
   *  acerto em andamento/concluído). Financiamento pendente NÃO bloqueia (operação ainda em aberto). */
  private isSettlingOrDone(deal: Deal | null): boolean {
    return !!deal && ['FULLY_SIGNED', 'SETTLEMENT_VALIDATION', 'SETTLING', 'SETTLED'].includes(deal.state);
  }

  /** Exclui a mesa (remove da conta). Bloqueada se a operação ativa estiver em liquidação/liquidada. */
  async deleteMesa(portalToken: string | undefined, mesaId: string): Promise<void> {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    const active = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    if (this.isSettlingOrDone(active)) throw new DomainError('VERSION_CONFLICT', 'Operação em liquidação/liquidada — não é possível excluir a mesa.');
    delete this.d.portal.mesas()[mesaId];
    this.d.portal.persistMesas();
    void this.audit('mesa.excluida', pm.id, { mesaId });
  }

  /** Exclui UMA operação (deal) da mesa. Bloqueada se estiver em liquidação/liquidada. Se era a ativa,
   *  destrava a mesa (approvedAt/termsHash) para permitir uma nova operação. */
  async deleteMesaDeal(portalToken: string | undefined, mesaId: string, dealId: string): Promise<{ deal: Record<string, unknown> | null }> {
    const pm = this.d.portal.requirePayMaster(portalToken);
    const mesa = this.mesaOf(pm.id, mesaId);
    if (mesa.dealId !== dealId && !(mesa.dealIds ?? []).includes(dealId)) throw new DomainError('INVALID_INPUT', 'Operação não pertence a esta mesa.');
    const deal = await this.d.getDeal(dealId);
    if (this.isSettlingOrDone(deal)) throw new DomainError('VERSION_CONFLICT', 'Operação em liquidação/liquidada — não é possível excluir.');
    mesa.dealIds = (mesa.dealIds ?? []).filter(id => id !== dealId);
    if (mesa.dealId === dealId) {
      mesa.dealId = mesa.dealIds.length ? (mesa.dealIds[mesa.dealIds.length - 1] as string) : null;
      if (!mesa.dealId) { mesa.approvedAt = undefined; mesa.termsHash = undefined; } // mesa volta a aceitar nova operação
    }
    this.d.portal.persistMesas();
    void this.audit('mesa.operacao.excluida', pm.id, { mesaId, dealId });
    const active = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    return { deal: this.dealSummary(active) };
  }

  /* ---------- DTO recortado por papel (aplicado no BACKEND) ---------- */

  private shortAddr(a: string): string { return a.length > 12 ? `${a.slice(0, 7)}…${a.slice(-3)}` : a; }

  /** TODAS as operações (deals) das mesas do PM — ativa + histórico, mais recentes primeiro. Cada item
   *  traz a mesa de origem para montar o link de visualização (/mesa?mesa=&op=). */
  async listAllOperations(portalToken: string | undefined): Promise<Array<{ mesaId: string; mesaCode: string; networkLabel: string; active: boolean; owner: boolean; deal: Record<string, unknown> }>> {
    const pm = this.d.portal.requirePayMaster(portalToken, false);
    // DONO + PARTICIPANDO — operações onde o PM é dono OU a carteira dele ocupa uma cadeira.
    const mesas = Object.values(this.d.portal.mesas()).filter(m => m.payMasterId === pm.id || this.pmIsChair(pm, m)).sort((a, b) => b.createdAt - a.createdAt);
    const out: Array<{ mesaId: string; mesaCode: string; networkLabel: string; active: boolean; owner: boolean; deal: Record<string, unknown> }> = [];
    for (const m of mesas) {
      const owner = m.payMasterId === pm.id;
      const ids = [...new Set([...(m.dealIds ?? []), ...(m.dealId ? [m.dealId] : [])])].reverse();
      for (const id of ids) {
        const deal = await this.d.getDeal(id).catch(() => null);
        const summary = this.dealSummary(deal);
        if (summary) out.push({ mesaId: m.mesaId, mesaCode: m.code, networkLabel: this.networksLabel(m), active: id === m.dealId, owner, deal: summary });
      }
    }
    return out;
  }

  /** Visão PÚBLICA (somente-leitura, sem sessão) de uma mesa — base do link /ver/<mesaId>. Mostra o que
   *  foi preenchido: config (valores/taxas), cadeiras (papel, ativo, nome, conectado, endereço curto) e
   *  o status + a operação resumida (se já existir). Não expõe convites/links/notas (mesmo recorte do participante). */
  async mesaPublicView(mesaId: string): Promise<Record<string, unknown>> {
    const mesa = this.d.portal.mesas()[mesaId];
    if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada.');
    const now = this.now();
    const invites = await this.d.store.listMesaInvites(mesa.mesaId);
    const deal = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    const status = deriveMesaStatus(mesa, invites, deal, now);
    return {
      mesaId: mesa.mesaId, code: mesa.code, operationCode: mesa.operationCode ?? null,
      network: mesa.network, networkLabel: this.networksLabel(mesa), status,
      createdAt: mesa.createdAt, expiresAt: mesa.expiresAt, serverTime: now,
      config: mesa.config ? { amountInBase: mesa.config.amountInBase ?? null, buyerAmountInBase: mesa.config.buyerAmountInBase ?? null, discountBps: mesa.config.discountBps, commissionBps: mesa.config.commissionBps, commissionPayer: mesa.config.commissionPayer ?? null } : null,
      chairs: mesa.chairs.map(c => ({
        role: c.role, roleLabel: CHAIR_ROLE_LABEL[c.role],
        asset: c.expectedAsset.symbol, network: c.expectedAsset.network,
        assetNetworkLabel: getChain(c.expectedAsset.network)?.displayName ?? c.expectedAsset.network,
        decimals: c.expectedAsset.decimals,
        firstName: c.firstName ?? null, connected: !!c.wallet,
        wallet: c.wallet ? this.shortAddr(c.wallet.address) : null,
      })),
      deal: this.dealSummary(deal),
    };
  }

  /** Endereços completos das cadeiras conectadas (uso interno das rotas públicas de SALDO — o
   *  public-view NUNCA expõe endereços cheios). Resolve o endereço na rede do ativo esperado. */
  mesaConnectedWallets(mesaId: string): { role: MesaChairRole; roleLabel: string; network: string; address: string; expected: ChairAsset }[] {
    const mesa = this.d.portal.mesas()[mesaId];
    if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada.');
    const out: { role: MesaChairRole; roleLabel: string; network: string; address: string; expected: ChairAsset }[] = [];
    for (const c of mesa.chairs) {
      const w = c.wallet; if (!w) continue;
      const net = c.expectedAsset.network;
      const addr = (w.addresses ?? []).find(a => a.network === net)?.address ?? w.address;
      out.push({ role: c.role, roleLabel: CHAIR_ROLE_LABEL[c.role], network: net, address: addr, expected: c.expectedAsset });
    }
    return out;
  }

  /** Resumo canônico de uma operação (deal) para a UI — mesma forma na mesa, na lista e no deep link. */
  private dealSummary(deal: Deal | null): Record<string, unknown> | null {
    if (!deal) return null;
    return {
      id: deal.id, state: deal.state, createdAt: deal.createdAt,
      requiredSignatures: deal.requiredSignatures, validSignatures: deal.validSignatures,
      turnRole: deal.turnRole ?? null, turnExpiresAt: deal.turnExpiresAt ?? null, expiresAt: deal.expiresAt,
      assetIn: deal.draft?.assetIn?.code ?? null, assetOut: deal.draft?.assetOut?.code ?? null, amountInBase: deal.draft?.amountInBase ?? null,
      signed: deal.signatures.filter(s => s.status === 'valid' && s.revision === deal.revision).map(s => s.role),
      // Estado de DEPÓSITO por papel + cofre HTLC (quando a rota tem perna BTC externa). Sem isso,
      // o participante que precisa trancar BTC não tinha COMO saber o endereço do cofre nem quanto
      // enviar — batia em FUNDING_REQUIRED na assinatura sem instrução nenhuma na tela.
      funding: deal.participants.filter(p => p.fundingRequired).map(p => ({ role: p.role, status: p.funding ?? 'PENDING', legIndex: deal.terms?.legs.find(l => l.from === p.role)?.index ?? null })),
      // LIGHTNING_SWAP: a UI mostra o selo "BTC via Lightning" e, p/ o Comprador, o estado da invoice
      // (precisa informá-la antes do approve). O valor em sats vem dos termos da perna lightning.
      lightning: (() => {
        if (deal.terms?.route.kind !== 'LIGHTNING_SWAP') return null;
        const leg = deal.terms?.legs.find(l => l.escrowChain === 'lightning');
        return { amountSat: leg?.amountBase ?? deal.draft?.amountInBase ?? null, hasInvoice: !!deal.lightningInvoice };
      })(),
      htlcVault: (() => {
        const leg = deal.terms?.legs.find(l => l.mode === 'HTLC' && l.escrowChain === 'bitcoin');
        if (!leg) return null;
        const meta = deal.onChain?.bitcoin?.meta as Record<string, unknown> | undefined;
        // simulated: a UI marca "BTC SIMULADO" quando a perna roda no simulador (preview/dev) —
        // exigência da auditoria: nenhum ambiente de teste pode se passar por BTC real.
        return typeof meta?.htlcAddress === 'string' ? { address: meta.htlcAddress, requiredSat: leg.amountBase, from: leg.from, legIndex: leg.index, simulated: this.d.btcSimulated?.() ?? false } : null;
      })(),
      // REGISTRO on-chain pendente (createTradeV2 do PM1): o auto-envio do approve é one-shot e
      // se perde em recusa/reload — sem este campo no poll a mesa ficava SEM retry, presa em
      // "Registrando o contrato na rede". Só enquanto os turnos estão adiados (turnRole null):
      // quando o registro confirma, healDeferredTurns inicia os turnos e o campo some sozinho.
      registerTx: (() => {
        if (deal.state !== 'AWAITING_SIGNATURES' || deal.turnRole != null) return null;
        const meta = deal.onChain?.ethereum?.meta as Record<string, unknown> | undefined;
        return meta?.registerPending && typeof meta.registerTx === 'string' ? JSON.parse(meta.registerTx) as Record<string, unknown> : null;
      })(),
      // REEMBOLSOS por perna (REFUNDED/PENDING): a UI mostra "aguardando timelock" em vez de
      // sumir com o estado — exigência da auditoria (recuperação explicável por operação).
      // (?? []: dado antigo/fake persistido pode não ter o campo — a view nunca pode quebrar)
      refunds: (deal.refunds ?? []).map(r => ({ role: r.role, legIndex: r.legIndex, status: r.status, txRef: r.txRef })),
    };
  }

  /** Resumo de UMA operação específica da mesa (deep link /mesa?mesa=&op=). Verifica que a operação
   *  pertence à mesa; autoriza participante (sessão da própria mesa) ou admin (dono). Só dados públicos. */
  async mesaDealSummary(mesaId: string, dealId: string, _viewer: { kind: 'admin' } | { kind: 'participant'; chairId: string }): Promise<{ deal: Record<string, unknown> | null; irreversible: boolean }> {
    const mesa = this.mesaById(mesaId);
    if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada.');
    const belongs = mesa.dealId === dealId || (mesa.dealIds ?? []).includes(dealId);
    if (!belongs) throw new DomainError('INVALID_INPUT', 'Operação não pertence a esta mesa.');
    const deal = await this.d.getDeal(dealId);
    if (!deal) throw new DomainError('INVALID_INPUT', 'Operação não encontrada.');
    return { deal: this.dealSummary(deal), irreversible: this.isIrreversible(deal) };
  }

  async mesaViewFor(mesa: MesaRecord, viewer: { kind: 'admin' } | { kind: 'participant'; chairId: string }): Promise<Record<string, unknown>> {
    const now = this.now();
    const invites = await this.d.store.listMesaInvites(mesa.mesaId);
    const deal = mesa.dealId ? await this.d.getDeal(mesa.dealId) : null;
    const status = deriveMesaStatus(mesa, invites, deal, now);
    const base = {
      mesaId: mesa.mesaId, code: mesa.code, operationCode: mesa.operationCode ?? null, network: mesa.network, networkLabel: this.networksLabel(mesa),
      settlement: deriveSettlementPlan(mesa.chairs),
      status, createdAt: mesa.createdAt, expiresAt: mesa.expiresAt, serverTime: now,
      approvedAt: mesa.approvedAt ?? null, termsHash: mesa.termsHash ?? null,
      // Trava de irrevogabilidade exposta ao frontend: canCancel=false → UI remove "Cancelar mesa".
      irreversible: this.isIrreversible(deal), canCancel: !mesa.cancelled && !this.isIrreversible(deal),
      deal: this.dealSummary(deal),
    };
    if (viewer.kind === 'admin') {
      const invByChair = new Map(invites.filter(i => i.status === 'PENDING' && i.expiresAt > now).map(i => [i.chairId, i]));
      // Todas as operações desta mesa (ativa + histórico, mais recentes primeiro) — cada uma tem link próprio.
      const dealIds = [...new Set([...(mesa.dealIds ?? []), ...(mesa.dealId ? [mesa.dealId] : [])])].reverse();
      const dealsFull = await Promise.all(dealIds.map(id => this.d.getDeal(id).catch(() => null)));
      const deals = dealsFull.filter((d): d is Deal => !!d).map(d => ({ ...this.dealSummary(d)!, active: d.id === mesa.dealId }));
      return {
        ...base, label: mesa.label ?? null, config: mesa.config ?? null, approvals: mesa.approvals, deals,
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
      viewer: me ? { chairId: me.chairId, role: me.role, roleLabel: CHAIR_ROLE_LABEL[me.role], firstName: me.firstName ?? null, wallet: me.wallet ? this.shortAddr(me.wallet.address) : null, asset: me.expectedAsset.symbol,
        // LIGHTNING_SWAP: o Comprador precisa informar a invoice antes do approve; a UI mostra o campo.
        lnInvoiceNeeded: me.role === 'BUYER' && deriveSettlementPlan(mesa.chairs)?.mode === 'LIGHTNING_SWAP' && !me.lightningInvoice,
        lnInvoiceProvided: !!me.lightningInvoice } : null,
      config: mesa.config ? { amountInBase: mesa.config.amountInBase ?? null, discountBps: mesa.config.discountBps, commissionBps: mesa.config.commissionBps, commissionPayer: mesa.config.commissionPayer ?? null } : null,
      chairs: mesa.chairs.map(c => ({
        role: c.role, roleLabel: CHAIR_ROLE_LABEL[c.role],
        firstName: c.firstName ?? null,
        wallet: c.wallet ? this.shortAddr(c.wallet.address) : null,
        asset: c.expectedAsset.symbol,
        decimals: c.expectedAsset.decimals,
        connected: !!c.wallet,
        isMe: c.chairId === viewer.chairId,
      })),
    };
  }
}
