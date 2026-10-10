/**
 * Portal Pay Master — cadastro, sessão por token, conexão de carteira e código de mesa de operação.
 * Persistência própria em arquivo JSON no servidor (independente do Store de deals), com hashing de senha
 * (scrypt) e comparação em tempo constante. Estado deixa de viver no navegador e passa a ser durável no servidor.
 */
import { scryptSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '../domain/errors.js';
import { TABLE_TTL_MS, INVITE_TTL_MS } from '../domain/constants.js';
import type { MesaRecord } from '../mesa/types.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from './totp.js';

/** Endereço público da carteira numa rede (chainKey da Verum). */
export interface WalletAddress { network: string; address: string }
export interface WalletLink {
  address: string;
  network: string;
  connectedAt: number;
  /** Endereços multichain expostos por verum.getAddresses() no connect/convite. */
  addresses?: WalletAddress[];
  /** true quando a carteira revelou mais de uma rede (multichain, ex.: Verum). */
  multichain?: boolean;
}
/** Controles de segurança da mesa (aplicados no backend). */
export interface DeskSecurity {
  /** 2FA TOTP: exigido para "assinar operações" (criar operação da mesa). `secret` é o segredo confirmado; `pending` é o segredo em enrollment ainda não validado. */
  twoFactor: { enabled: boolean; secret?: string; pending?: string; enabledAt?: number };
  /** Encerra a sessão do portal após `timeoutMs` sem atividade. */
  idleLock: { enabled: boolean; timeoutMs: number };
  /** Emite alerta ao conectar/confirmar uma carteira nunca vista nesta mesa. */
  newWalletAlert: { enabled: boolean };
}
export type SecurityAlertType = 'new_wallet' | '2fa_enabled' | '2fa_disabled' | 'idle_logout';
export interface SecurityAlert { id: string; type: SecurityAlertType; at: number; message: string; read: boolean }
export interface PayMaster { id: string; name: string; email: string; org: string; salt: string; passHash: string; createdAt: number; wallet: WalletLink | null; mesaDealId?: string | null; mesaDealIds?: string[]; security?: DeskSecurity; knownWallets?: string[]; alerts?: SecurityAlert[]; demo?: boolean; /** Carteiras pré-conectadas na conta (aba Carteiras), por papel — reusadas para preencher as cadeiras ao criar a mesa. */ deskWallets?: Partial<Record<SlotRole, { name?: string; link: WalletLink }>> }
export interface PortalSession { token: string; payMasterId: string; createdAt: number; expiresAt: number; lastSeenAt: number }
export interface MesaCode { code: string; uid: string; payMasterId: string; createdAt: number; expiresAt: number }

/** Papéis das outras carteiras da mesa (o PM1 é o próprio Pay Master, via pm.wallet). */
export type MesaRole = 'SELLER' | 'BUYER' | 'PAYMASTER_2';
/** Convite por papel: link portador que permite ao dono conectar a própria carteira sem login do PM. */
export interface MesaInvite { token: string; payMasterId: string; role: MesaRole; network: string; label?: string; status: 'pending' | 'confirmed'; wallet: WalletLink | null; createdAt: number; expiresAt: number }

export interface PortalData { seq: number; /** Versão monotônica do documento (concorrência serverless): cada write() incrementa; o save no Postgres só aplica se rev for mais novo que o do banco — evita que uma instância com memória velha sobrescreva escritas de outra. */ rev?: number; payMasters: Record<string, PayMaster>; sessions: Record<string, PortalSession>; codes: Record<string, MesaCode>; invites: Record<string, MesaInvite>; mesas: Record<string, MesaRecord> }
export function emptyPortalData(): PortalData { return { seq: 0, rev: 0, payMasters: {}, sessions: {}, codes: {}, invites: {}, mesas: {} }; }

/**
 * Backend de persistência do portal. `file` (dev, síncrono) ou `postgres` (Supabase). No serverless
 * o estado NÃO pode viver em memória/arquivo por-instância; o backend postgres é hidratado por
 * request e persistido após mutações — assim a sessão sobrevive entre invocações.
 */
export interface PortalPersistence {
  initial(): PortalData | null;          // dados síncronos no boot (file) ou null (postgres → hydrate async)
  hydrate(): Promise<PortalData | null>; // carga assíncrona (postgres: SELECT; file: lê o arquivo)
  save(data: PortalData): void;          // dispara persistência (postgres: async fire-and-forget rastreado)
  flush(): Promise<void>;                // aguarda a última escrita pendente (no-op no file)
}

export interface SafePayMaster { id: string; name: string; email: string; org: string; role: 'Pay Master 1'; createdAt: number; demo?: boolean }
/** Visão de segurança exposta ao painel (nunca inclui o segredo TOTP). */
export interface PublicSecurity { twoFactor: { enabled: boolean; enabledAt?: number }; idleLock: { enabled: boolean; timeoutMs: number }; newWalletAlert: { enabled: boolean } }
/** Dados de enrollment do 2FA (mostrados uma única vez ao ativar). */
export interface TwoFactorSetup { secret: string; otpauthUri: string; issuer: string; account: string }
export interface MePayload { payMaster: SafePayMaster; wallet: WalletLink | null; code: PublicCode | null }
export interface PublicCode { code: string; uid: string; createdAt: number; expiresAt: number; ttlMs: number }

export type SlotRole = 'SELLER' | 'BUYER' | 'PAYMASTER_1' | 'PAYMASTER_2';
export interface PublicInvite { token: string; role: MesaRole; label?: string; status: MesaInvite['status'] | 'expired'; expiresAt: number; ttlMs: number; wallet: WalletLink | null }
export interface MesaSlot { role: SlotRole; status: 'empty' | 'pending' | 'confirmed' | 'expired'; wallet: WalletLink | null; invite: PublicInvite | null }
export interface MesaView { payMaster: SafePayMaster; slots: MesaSlot[] }
export interface ResolvedInvite { payMaster: SafePayMaster; role: MesaRole; network: string; label?: string; status: MesaInvite['status'] | 'expired' }

const HOUR = 3600_000; // sessões longas do portal
// Mesa e convite vivem pelos parâmetros canônicos (TABLE_TTL_MS / INVITE_TTL_MS).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PortalService {
  private data: PortalData;
  private readonly persistence?: PortalPersistence;
  // `file` é opcional quando um `persistence` (ex.: postgres) é fornecido.
  constructor(private readonly opts: { file?: string; sessionTtlMs?: number; now?: () => number; persistence?: PortalPersistence }) {
    this.persistence = opts.persistence;
    this.data = this.persistence ? (this.persistence.initial() ?? emptyPortalData()) : this.read();
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private sessionTtl(): number { return this.opts.sessionTtlMs ?? 24 * HOUR; }

  /** Recarrega o estado do backend (postgres). Chamado por request no serverless p/ ver escritas de outras instâncias. No-op sem persistence async. */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    const d = await this.persistence.hydrate();
    // Só adota o documento do banco se NÃO for mais velho que a memória — um SELECT que resolve
    // tarde (concorrência na mesma instância) não pode desfazer uma mutação local recém-gravada.
    if (d && (d.rev ?? 0) >= (this.data.rev ?? 0)) this.data = { seq: d.seq ?? 0, rev: d.rev ?? 0, payMasters: d.payMasters ?? {}, sessions: d.sessions ?? {}, codes: d.codes ?? {}, invites: d.invites ?? {}, mesas: d.mesas ?? {} };
  }
  /** Aguarda a última escrita pendente ser persistida (usado após mutações no serverless). */
  async flush(): Promise<void> { if (this.persistence) await this.persistence.flush(); }

  /** Diagnóstico da persistência (roundtrip + resumo do que está NO BANCO). null sem backend async. */
  async persistenceHealth(): Promise<Record<string, unknown> | null> {
    const p = this.persistence as (PortalPersistence & { health?: () => Promise<Record<string, unknown>> }) | undefined;
    return p?.health ? p.health() : null;
  }

  private read(): PortalData {
    const file = this.opts.file;
    try {
      if (file && existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PortalData>;
        return { seq: raw.seq ?? 0, rev: raw.rev ?? 0, payMasters: raw.payMasters ?? {}, sessions: raw.sessions ?? {}, codes: raw.codes ?? {}, invites: raw.invites ?? {}, mesas: raw.mesas ?? {} };
      }
    } catch { /* arquivo corrompido/ausente → começa vazio */ }
    return emptyPortalData();
  }
  private write(): void {
    this.data.rev = (this.data.rev ?? 0) + 1;
    if (this.persistence) { this.persistence.save(this.data); return; }
    const file = this.opts.file; if (!file) return;
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  private hash(password: string, salt: string): string { return scryptSync(password, salt, 32).toString('hex'); }
  private safe(pm: PayMaster): SafePayMaster { return { id: pm.id, name: pm.name, email: pm.email, org: pm.org, role: 'Pay Master 1', createdAt: pm.createdAt, ...(pm.demo ? { demo: true } : {}) }; }
  private publicCode(c: MesaCode): PublicCode { return { code: c.code, uid: c.uid, createdAt: c.createdAt, expiresAt: c.expiresAt, ttlMs: Math.max(0, c.expiresAt - this.now()) }; }

  private newSession(payMasterId: string): PortalSession {
    const now = this.now();
    const s: PortalSession = { token: randomBytes(32).toString('base64url'), payMasterId, createdAt: now, expiresAt: now + this.sessionTtl(), lastSeenAt: now };
    this.data.sessions[s.token] = s;
    return s;
  }

  // Persistência throttled do lastSeenAt: evita escrever o arquivo a cada request
  // do polling; grava no máx. a cada 30s por token (o valor em memória é sempre exato).
  private lastPersistSeen = new Map<string, number>();

  /**
   * Resolve a sessão do token (ou lança). Aplica o bloqueio por inatividade e faz limpeza preguiçosa.
   * `activity=true` (ações do usuário) renova a janela de inatividade; `false` (leituras de polling
   * do painel) apenas verifica — assim o polling em background não mantém a sessão viva para sempre.
   */
  session(token: string | undefined, activity = true): PortalSession {
    if (!token) throw new DomainError('FORBIDDEN', 'Sessão do portal necessária');
    const now = this.now();
    const s = this.data.sessions[token];
    if (!s || s.expiresAt <= now) { if (s) { delete this.data.sessions[token]; this.write(); } throw new DomainError('FORBIDDEN', 'Sessão inválida ou expirada'); }
    const pm = this.data.payMasters[s.payMasterId];
    const idle = pm && this.ensureSecurity(pm).idleLock;
    if (idle && idle.enabled && now - (s.lastSeenAt ?? s.createdAt) > idle.timeoutMs) {
      delete this.data.sessions[token]; this.lastPersistSeen.delete(token);
      if (pm) this.pushAlert(pm, 'idle_logout', `Sessão encerrada por inatividade (> ${Math.round(idle.timeoutMs / 60000)} min).`);
      this.write();
      throw new DomainError('FORBIDDEN', 'Sessão encerrada por inatividade');
    }
    if (activity) {
      // renova a janela de inatividade e persiste com throttle (no máx. 1×/30s por token).
      s.lastSeenAt = now;
      const lp = this.lastPersistSeen.get(token) ?? 0;
      if (now - lp > 30_000) { this.lastPersistSeen.set(token, now); this.write(); }
    }
    return s;
  }
  private pm(id: string): PayMaster { const pm = this.data.payMasters[id]; if (!pm) throw new DomainError('FORBIDDEN', 'Pay Master não encontrado'); return pm; }

  register(input: { name: string; email: string; org?: string; password: string }): { token: string; payMaster: SafePayMaster } {
    const name = input.name.trim(), email = input.email.trim().toLowerCase(), org = (input.org ?? '').trim();
    if (name.length < 2) throw new DomainError('INVALID_INPUT', 'Nome inválido');
    if (!EMAIL_RE.test(email)) throw new DomainError('INVALID_INPUT', 'E-mail inválido');
    if (input.password.length < 8) throw new DomainError('INVALID_INPUT', 'Senha deve ter ao menos 8 caracteres');
    if (Object.values(this.data.payMasters).some(p => p.email === email)) throw new DomainError('VERSION_CONFLICT', 'E-mail já cadastrado');
    const salt = randomBytes(16).toString('hex');
    const pm: PayMaster = { id: 'pm_' + randomUUID(), name, email, org, salt, passHash: this.hash(input.password, salt), createdAt: this.now(), wallet: null };
    this.data.payMasters[pm.id] = pm;
    const s = this.newSession(pm.id);
    this.write();
    return { token: s.token, payMaster: this.safe(pm) };
  }

  login(input: { email: string; password: string }): { token: string; payMaster: SafePayMaster } {
    const email = input.email.trim().toLowerCase();
    const pm = Object.values(this.data.payMasters).find(p => p.email === email);
    const bad = new DomainError('FORBIDDEN', 'Credenciais inválidas');
    if (!pm) throw bad;
    const attempt = Buffer.from(this.hash(input.password, pm.salt), 'hex');
    const stored = Buffer.from(pm.passHash, 'hex');
    if (attempt.length !== stored.length || !timingSafeEqual(attempt, stored)) throw bad;
    const s = this.newSession(pm.id);
    this.write();
    return { token: s.token, payMaster: this.safe(pm) };
  }

  logout(token: string | undefined): void { if (token && this.data.sessions[token]) { delete this.data.sessions[token]; this.write(); } }

  me(token: string | undefined): MePayload {
    const s = this.session(token, false); // leitura (polling do painel) — não renova inatividade
    const pm = this.pm(s.payMasterId);
    return { payMaster: this.safe(pm), wallet: pm.wallet, code: this.validCode(pm.id) };
  }

  connectWallet(token: string | undefined, input: { address: string; network: string; addresses?: WalletAddress[] }): WalletLink {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const address = input.address.trim();
    if (address.length < 8 || address.length > 120) throw new DomainError('INVALID_INPUT', 'Endereço de carteira inválido');
    pm.wallet = this.walletLink(address, input.network, input.addresses);
    this.noteWallet(pm, pm.wallet, 'Pay Master 1');
    this.write();
    return pm.wallet;
  }

  /** Conecta a carteira de um PAPEL na conta (aba Carteiras) — usada para preencher a cadeira ao criar
   *  a mesa, sem convite. A posse real continua sendo provada na ASSINATURA da operação. */
  connectDeskWallet(token: string | undefined, input: { role: SlotRole; address: string; network: string; addresses?: WalletAddress[]; name?: string }): Partial<Record<SlotRole, { name?: string; link: WalletLink }>> {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const address = input.address.trim();
    if (address.length < 8 || address.length > 120) throw new DomainError('INVALID_INPUT', 'Endereço de carteira inválido');
    const link = this.walletLink(address, input.network, input.addresses);
    const name = input.name?.trim() ? input.name.trim().slice(0, 30) : undefined;
    pm.deskWallets = { ...(pm.deskWallets ?? {}), [input.role]: { name, link } };
    if (input.role === 'PAYMASTER_1') pm.wallet = link; // PM1 é o próprio admin — mantém pm.wallet em sincronia
    this.noteWallet(pm, link, input.role);
    this.write();
    return this.listDeskWallets(token);
  }
  disconnectDeskWallet(token: string | undefined, role: SlotRole): Partial<Record<SlotRole, { name?: string; link: WalletLink }>> {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const next = { ...(pm.deskWallets ?? {}) }; delete next[role];
    pm.deskWallets = next;
    if (role === 'PAYMASTER_1') pm.wallet = null;
    this.write();
    return this.listDeskWallets(token);
  }
  listDeskWallets(token: string | undefined): Partial<Record<SlotRole, { name?: string; link: WalletLink }>> {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const out: Partial<Record<SlotRole, { name?: string; link: WalletLink }>> = { ...(pm.deskWallets ?? {}) };
    if (pm.wallet && !out['PAYMASTER_1']) out['PAYMASTER_1'] = { link: pm.wallet }; // compat: PM1 conectado pelo fluxo antigo
    return out;
  }
  /** Leitura p/ o MesaService: carteira pré-conectada de um papel (ou null). */
  deskWalletFor(pm: PayMaster, role: SlotRole): { name?: string; link: WalletLink } | null {
    if (role === 'PAYMASTER_1') return pm.deskWallets?.['PAYMASTER_1'] ?? (pm.wallet ? { link: pm.wallet } : null);
    return pm.deskWallets?.[role] ?? null;
  }

  /** Higieniza e deduplica os endereços multichain; marca multichain se >1 rede. Público: reutilizado pelo MesaService. */
  walletLink(address: string, network: string, addresses?: WalletAddress[]): WalletLink {
    const seen = new Set<string>();
    const clean: WalletAddress[] = [];
    for (const e of addresses ?? []) {
      const net = typeof e?.network === 'string' ? e.network.trim().toLowerCase() : '';
      const addr = typeof e?.address === 'string' ? e.address.trim() : '';
      if (!net || addr.length < 8 || addr.length > 120 || seen.has(net)) continue;
      seen.add(net);
      clean.push({ network: net, address: addr });
      if (clean.length >= 30) break;
    }
    // Garante que a rede primária (a que provou posse) esteja na lista.
    if (!seen.has(network.toLowerCase()) && clean.length) {
      clean.unshift({ network: network.toLowerCase(), address });
    }
    return {
      address,
      network,
      connectedAt: this.now(),
      addresses: clean.length ? clean : undefined,
      multichain: clean.length > 1 || undefined,
    };
  }

  disconnectWallet(token: string | undefined): void {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    pm.wallet = null;
    for (const [k, c] of Object.entries(this.data.codes)) if (c.payMasterId === pm.id) delete this.data.codes[k];
    this.write();
  }

  /* ---------- Controles de segurança da mesa (2FA, bloqueio por inatividade, alerta de carteira) ---------- */
  private defaultSecurity(): DeskSecurity {
    return { twoFactor: { enabled: false }, idleLock: { enabled: true, timeoutMs: 10 * 60_000 }, newWalletAlert: { enabled: false } };
  }
  /** Garante a estrutura de segurança no registro (migração preguiçosa de PMs antigos). */
  private ensureSecurity(pm: PayMaster): DeskSecurity {
    if (!pm.security) pm.security = this.defaultSecurity();
    const d = this.defaultSecurity();
    pm.security.twoFactor ??= d.twoFactor;
    pm.security.idleLock ??= d.idleLock;
    pm.security.newWalletAlert ??= d.newWalletAlert;
    if (typeof pm.security.idleLock.timeoutMs !== 'number' || pm.security.idleLock.timeoutMs < 60_000) pm.security.idleLock.timeoutMs = d.idleLock.timeoutMs;
    return pm.security;
  }
  private publicSecurity(sec: DeskSecurity): PublicSecurity {
    return { twoFactor: { enabled: sec.twoFactor.enabled, enabledAt: sec.twoFactor.enabledAt }, idleLock: { enabled: sec.idleLock.enabled, timeoutMs: sec.idleLock.timeoutMs }, newWalletAlert: { enabled: sec.newWalletAlert.enabled } };
  }

  getSecurity(token: string | undefined): PublicSecurity {
    const s = this.session(token, false); // leitura
    const pm = this.pm(s.payMasterId);
    return this.publicSecurity(this.ensureSecurity(pm));
  }

  /** Atualiza os controles que não exigem enrollment (inatividade e alerta de carteira). 2FA usa os métodos dedicados. */
  updateSecurity(token: string | undefined, patch: { idleLock?: { enabled?: boolean; timeoutMinutes?: number }; newWalletAlert?: { enabled?: boolean } }): PublicSecurity {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const sec = this.ensureSecurity(pm);
    if (patch.idleLock) {
      if (typeof patch.idleLock.enabled === 'boolean') sec.idleLock.enabled = patch.idleLock.enabled;
      if (typeof patch.idleLock.timeoutMinutes === 'number') sec.idleLock.timeoutMs = Math.max(1, Math.min(240, Math.round(patch.idleLock.timeoutMinutes))) * 60_000;
    }
    if (patch.newWalletAlert && typeof patch.newWalletAlert.enabled === 'boolean') sec.newWalletAlert.enabled = patch.newWalletAlert.enabled;
    this.write();
    return this.publicSecurity(sec);
  }

  private readonly TOTP_ISSUER = 'VERUM OTC';
  /** Inicia o enrollment do 2FA: gera um segredo pendente e devolve a chave/URI (mostrada uma vez). Não habilita ainda. */
  begin2FA(token: string | undefined): TwoFactorSetup {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const sec = this.ensureSecurity(pm);
    if (sec.twoFactor.enabled) throw new DomainError('VERSION_CONFLICT', '2FA já está ativo');
    const secret = generateTotpSecret();
    sec.twoFactor.pending = secret;
    this.write();
    const account = pm.email;
    return { secret, otpauthUri: otpauthUri({ secret, label: account, issuer: this.TOTP_ISSUER }), issuer: this.TOTP_ISSUER, account };
  }
  /** Confirma o 2FA validando um código do segredo pendente; só então habilita. */
  confirm2FA(token: string | undefined, code: string): PublicSecurity {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const sec = this.ensureSecurity(pm);
    const pending = sec.twoFactor.pending;
    if (!pending) throw new DomainError('INVALID_INPUT', 'Nenhum enrollment de 2FA em andamento. Inicie novamente.');
    if (!verifyTotp(pending, code, this.now())) throw new DomainError('INVALID_INPUT', 'Código 2FA inválido');
    sec.twoFactor = { enabled: true, secret: pending, enabledAt: this.now() };
    this.pushAlert(pm, '2fa_enabled', 'Autenticação de dois fatores ativada.');
    this.write();
    return this.publicSecurity(sec);
  }
  /** Desativa o 2FA (exige um código válido para provar posse). */
  disable2FA(token: string | undefined, code: string): PublicSecurity {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const sec = this.ensureSecurity(pm);
    if (!sec.twoFactor.enabled || !sec.twoFactor.secret) { sec.twoFactor = { enabled: false }; this.write(); return this.publicSecurity(sec); }
    if (!verifyTotp(sec.twoFactor.secret, code, this.now())) throw new DomainError('INVALID_INPUT', 'Código 2FA inválido');
    sec.twoFactor = { enabled: false };
    this.pushAlert(pm, '2fa_disabled', 'Autenticação de dois fatores desativada.');
    this.write();
    return this.publicSecurity(sec);
  }
  /** Enforcement: se o 2FA está ativo, exige um código TOTP válido para a ação sensível. */
  require2FA(token: string | undefined, code: string | undefined): void {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    const sec = this.ensureSecurity(pm);
    if (!sec.twoFactor.enabled || !sec.twoFactor.secret) return;
    if (!code) throw new DomainError('TWO_FACTOR_REQUIRED', 'Código 2FA obrigatório para assinar operações');
    if (!verifyTotp(sec.twoFactor.secret, code, this.now())) throw new DomainError('INVALID_INPUT', 'Código 2FA inválido');
  }

  /* ---------- Alertas de segurança ---------- */
  private pushAlert(pm: PayMaster, type: SecurityAlertType, message: string): void {
    if (!pm.alerts) pm.alerts = [];
    pm.alerts.push({ id: 'al_' + randomBytes(6).toString('hex'), type, at: this.now(), message, read: false });
    if (pm.alerts.length > 50) pm.alerts = pm.alerts.slice(-50);
  }
  listAlerts(token: string | undefined): { alerts: SecurityAlert[]; unread: number } {
    const s = this.session(token, false); // polado pelo painel — leitura
    const pm = this.pm(s.payMasterId);
    const alerts = (pm.alerts ?? []).slice().sort((a, b) => b.at - a.at);
    return { alerts, unread: alerts.filter(a => !a.read).length };
  }
  markAlertsRead(token: string | undefined): void {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    if (pm.alerts) { for (const a of pm.alerts) a.read = true; this.write(); }
  }

  /** Endereços (minúsculos) de um WalletLink — inclui os multichain. */
  private addressesOf(w: WalletLink): string[] {
    const out = new Set<string>();
    if (w.address) out.add(w.address.toLowerCase());
    for (const e of w.addresses ?? []) if (e.address) out.add(e.address.toLowerCase());
    return [...out];
  }
  /** Registra as carteiras vistas e, se habilitado, emite alerta para endereços novos. Chamado ao conectar/confirmar. */
  private noteWallet(pm: PayMaster, w: WalletLink, ctx: string): void {
    const sec = this.ensureSecurity(pm);
    const known = new Set(pm.knownWallets ?? []);
    const incoming = this.addressesOf(w);
    const fresh = incoming.filter(a => !known.has(a));
    for (const a of incoming) known.add(a);
    pm.knownWallets = [...known].slice(-200);
    const shown = fresh[0];
    if (sec.newWalletAlert.enabled && shown) {
      const short = shown.length > 12 ? shown.slice(0, 6) + '…' + shown.slice(-4) : shown;
      this.pushAlert(pm, 'new_wallet', `Nova carteira conectada (${ctx}): ${short}`);
    }
  }

  /** Código de mesa único com validade de 1 hora. Exige carteira conectada. Invalida o código anterior do Pay Master. */
  generateCode(token: string | undefined): PublicCode {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    if (!pm.wallet) throw new DomainError('INVALID_INPUT', 'Conecte a carteira antes de gerar o código');
    for (const [k, c] of Object.entries(this.data.codes)) if (c.payMasterId === pm.id) delete this.data.codes[k];
    const now = this.now();
    const uid = String(++this.data.seq).padStart(6, '0');
    let code: string;
    do { code = this.makeMesaCode(); } while (this.data.codes[code]);
    const rec: MesaCode = { code, uid, payMasterId: pm.id, createdAt: now, expiresAt: now + TABLE_TTL_MS };
    this.data.codes[code] = rec;
    this.write();
    return this.publicCode(rec);
  }

  /** Gerador EXISTENTE do código de mesa (MESA-XXXX-XXXX-XXXX) — fatorado p/ reuso pelas mesas v3. */
  private makeMesaCode(): string {
    const seg = (n: number): string => Math.abs(Math.floor(n)).toString(36).toUpperCase().padStart(4, '0').slice(-4);
    return `MESA-${seg(this.data.seq + 100000)}-${seg(randomBytes(3).readUIntBE(0, 3))}-${seg(randomBytes(3).readUIntBE(0, 3))}`;
  }

  /* ---------- Mesas multi-instância (v3) — armazenamento no PortalData; lógica no MesaService ---------- */
  /** Pay Master da sessão (lança se sessão inválida). `activity=false` para leituras de polling. */
  requirePayMaster(token: string | undefined, activity = true): PayMaster {
    const s = this.session(token, activity);
    return this.pm(s.payMasterId);
  }
  /** Mapa mutável das mesas (hidratação tolerante p/ documentos antigos). */
  mesas(): Record<string, MesaRecord> { this.data.mesas ??= {}; return this.data.mesas; }
  /** Persiste após mutação de mesa (mesma durabilidade serverless do restante do portal). */
  persistMesas(): void { this.write(); }
  /** Código único de mesa v3 (mesmo gerador; unicidade contra codes e mesas). */
  newMesaCode(): string {
    this.data.seq += 1;
    let code: string;
    const taken = (c: string): boolean => !!this.data.codes[c] || Object.values(this.mesas()).some(m => m.code === c);
    do { code = this.makeMesaCode(); } while (taken(code));
    return code;
  }

  private validCode(payMasterId: string): PublicCode | null {
    const now = this.now(); let found: MesaCode | null = null; let changed = false;
    for (const [k, c] of Object.entries(this.data.codes)) {
      if (c.expiresAt <= now) { delete this.data.codes[k]; changed = true; continue; }
      if (c.payMasterId === payMasterId) found = c;
    }
    if (changed) this.write();
    return found ? this.publicCode(found) : null;
  }
  currentCode(token: string | undefined): PublicCode | null { const s = this.session(token, false); return this.validCode(s.payMasterId); }

  /** Valida um código de mesa (usado pela tela de operação para vincular a mesa). */
  resolveCode(code: string): { code: PublicCode; payMaster: SafePayMaster; wallet: WalletLink | null } | null {
    const c = this.data.codes[code];
    if (!c || c.expiresAt <= this.now()) return null;
    const pm = this.data.payMasters[c.payMasterId];
    if (!pm) return null;
    return { code: this.publicCode(c), payMaster: this.safe(pm), wallet: pm.wallet };
  }

  /* ---------- Convites de carteira por papel (Vendedor, Comprador, Pay Master 2) ---------- */
  private publicInvite(inv: MesaInvite): PublicInvite {
    const now = this.now();
    const status = inv.status === 'pending' && inv.expiresAt <= now ? 'expired' : inv.status;
    return { token: inv.token, role: inv.role, label: inv.label, status, expiresAt: inv.expiresAt, ttlMs: Math.max(0, inv.expiresAt - now), wallet: inv.wallet };
  }
  /** Remove convites pendentes vencidos (convites confirmados são preservados). */
  private pruneInvites(): boolean {
    const now = this.now(); let changed = false;
    for (const [k, inv] of Object.entries(this.data.invites)) if (inv.status === 'pending' && inv.expiresAt <= now) { delete this.data.invites[k]; changed = true; }
    return changed;
  }

  /** PM gera um convite para um papel; invalida o convite anterior do mesmo papel. */
  createInvite(token: string | undefined, input: { role: MesaRole; network: string; label?: string }): PublicInvite {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    for (const [k, inv] of Object.entries(this.data.invites)) if (inv.payMasterId === pm.id && inv.role === input.role) delete this.data.invites[k];
    const now = this.now();
    const inviteToken = randomBytes(24).toString('base64url');
    const rec: MesaInvite = { token: inviteToken, payMasterId: pm.id, role: input.role, network: input.network, label: input.label?.trim() || undefined, status: 'pending', wallet: null, createdAt: now, expiresAt: now + INVITE_TTL_MS };
    this.data.invites[inviteToken] = rec;
    this.write();
    return this.publicInvite(rec);
  }

  /** Agregado dos 4 slots da mesa (PM1 = pm.wallet; demais = convites). Alimenta o polling do painel. */
  listMesa(token: string | undefined): MesaView {
    const s = this.session(token, false); // agregado polado pelo painel — leitura
    const pm = this.pm(s.payMasterId);
    const changed = this.pruneInvites();
    const now = this.now();
    const byRole = new Map<MesaRole, MesaInvite>();
    for (const inv of Object.values(this.data.invites)) if (inv.payMasterId === pm.id) byRole.set(inv.role, inv);
    const slotFor = (role: MesaRole): MesaSlot => {
      const inv = byRole.get(role);
      if (!inv) return { role, status: 'empty', wallet: null, invite: null };
      const status = inv.status === 'pending' && inv.expiresAt <= now ? 'expired' : inv.status;
      return { role, status, wallet: inv.wallet, invite: this.publicInvite(inv) };
    };
    const slots: MesaSlot[] = [
      { role: 'PAYMASTER_1', status: pm.wallet ? 'confirmed' : 'empty', wallet: pm.wallet, invite: null },
      slotFor('SELLER'), slotFor('BUYER'), slotFor('PAYMASTER_2'),
    ];
    if (changed) this.write();
    return { payMaster: this.safe(pm), slots };
  }

  /** Endereço Solana de uma carteira da mesa (multichain expõe várias; Solana é a base da Verum). */
  private solanaAddress(w: WalletLink | null): string | null {
    if (!w) return null;
    if (Array.isArray(w.addresses)) { const e = w.addresses.find(a => a.network === 'solana'); if (e) return e.address; }
    return w.network === 'solana' ? w.address : null;
  }
  /** Participantes da mesa (papel + endereço Solana) prontos para criar a Deal. Exige SELLER/BUYER/PM1 confirmados. */
  mesaParticipants(token: string | undefined): { role: SlotRole; address: string }[] {
    const view = this.listMesa(token);
    const out: { role: SlotRole; address: string }[] = [];
    for (const slot of view.slots) {
      const addr = this.solanaAddress(slot.wallet);
      if (slot.status !== 'confirmed' || !addr) {
        if (slot.role === 'PAYMASTER_2') continue; // 4º participante é opcional
        throw new DomainError('INVALID_INPUT', `Carteira do papel ${slot.role} ainda não confirmada (ou sem endereço Solana)`);
      }
      out.push({ role: slot.role, address: addr });
    }
    if (out.length < 3) throw new DomainError('INVALID_INPUT', 'A mesa precisa de Vendedor, Comprador e Pay Master 1 confirmados');
    return out;
  }
  setMesaDeal(token: string | undefined, dealId: string | null): void {
    const s = this.session(token); const pm = this.pm(s.payMasterId);
    pm.mesaDealId = dealId;
    // Histórico da mesa: toda deal criada entra na lista (sem duplicar; cap de 50, mais recentes ao fim).
    if (dealId) { const ids = (pm.mesaDealIds ?? []).filter(id => id !== dealId); ids.push(dealId); pm.mesaDealIds = ids.slice(-50); }
    this.write();
  }
  getMesaDeal(token: string | undefined): string | null { const s = this.session(token, false); const pm = this.pm(s.payMasterId); return pm.mesaDealId ?? null; }
  /** Ids de todas as deals já criadas nesta mesa (mais recentes primeiro). */
  getMesaDeals(token: string | undefined): string[] { const s = this.session(token, false); const pm = this.pm(s.payMasterId); const ids = [...(pm.mesaDealIds ?? [])]; if (pm.mesaDealId && !ids.includes(pm.mesaDealId)) ids.push(pm.mesaDealId); return ids.reverse(); }
  /** Limpa o histórico de operações da mesa (demo/dev): a lista recomeça vazia. */
  clearMesaDeals(token: string | undefined): void {
    const s = this.session(token); const pm = this.pm(s.payMasterId);
    pm.mesaDealId = null; pm.mesaDealIds = [];
    this.write();
  }
  /** Torna ativa uma deal do histórico (a esteira/assinatura passam a apontar p/ ela). */
  selectMesaDeal(token: string | undefined, dealId: string): void {
    const s = this.session(token); const pm = this.pm(s.payMasterId);
    const ids = pm.mesaDealIds ?? (pm.mesaDealId ? [pm.mesaDealId] : []);
    if (!ids.includes(dealId)) throw new DomainError('INVALID_INPUT', 'Operação não pertence a esta mesa');
    pm.mesaDealId = dealId; this.write();
  }

  /** Resolve um convite pelo token — público (sem sessão), para a página /convite. */
  resolveInvite(token: string): ResolvedInvite | null {
    const inv = this.data.invites[token];
    if (!inv) return null;
    const pm = this.data.payMasters[inv.payMasterId];
    if (!pm) return null;
    const expired = inv.status === 'pending' && inv.expiresAt <= this.now();
    return { payMaster: this.safe(pm), role: inv.role, network: inv.network, label: inv.label, status: expired ? 'expired' : inv.status };
  }

  /** Confirma o convite vinculando a carteira já provada (a verificação de assinatura é feita na rota). */
  confirmInvite(token: string, wallet: { address: string; network: string; addresses?: WalletAddress[] }): PublicInvite {
    const inv = this.data.invites[token];
    if (!inv) throw new DomainError('INVALID_INPUT', 'Convite inválido ou inexistente');
    if (inv.status === 'pending' && inv.expiresAt <= this.now()) { delete this.data.invites[token]; this.write(); throw new DomainError('INVALID_INPUT', 'Convite expirado'); }
    const address = wallet.address.trim();
    if (address.length < 8 || address.length > 120) throw new DomainError('INVALID_INPUT', 'Endereço de carteira inválido');
    inv.status = 'confirmed';
    inv.wallet = this.walletLink(address, wallet.network, wallet.addresses);
    const owner = this.data.payMasters[inv.payMasterId];
    if (owner) this.noteWallet(owner, inv.wallet, inv.role);
    this.write();
    return this.publicInvite(inv);
  }

  /** Sessão pertence à conta demo? (leitura; nunca lança — usado por rotas públicas). */
  isDemoSession(token: string | undefined): boolean {
    try { const s = this.session(token, false); return !!this.pm(s.payMasterId).demo; } catch { return false; }
  }

  /**
   * Semeia a conta DEMO (apresentações; nunca em produção): cria o Pay Master com e-mail/senha fixos
   * e deixa a mesa 4/4 conectada com as carteiras falsas do keyring demo. Idempotente — no serverless
   * cada instância re-semeia no boot e só completa o que faltar.
   */
  seedDemo(input: { email: string; password: string; wallets: Record<SlotRole, { address: string; addresses: WalletAddress[] }> }): void {
    const email = input.email.trim().toLowerCase();
    let pm = Object.values(this.data.payMasters).find(p => p.email === email);
    let changed = false;
    if (!pm) {
      const salt = randomBytes(16).toString('hex');
      pm = { id: 'pm_demo', name: 'Mesa Demonstração', email, org: 'VERUM OTC — Demo', salt, passHash: this.hash(input.password, salt), createdAt: this.now(), wallet: null, demo: true };
      this.data.payMasters[pm.id] = pm; changed = true;
    }
    if (!pm.demo) { pm.demo = true; changed = true; }
    const link = (w: { address: string; addresses: WalletAddress[] }) => this.walletLink(w.address, 'solana', w.addresses);
    // Re-sincroniza endereços divergentes: um seed antigo (outra instância/segredo) pode ter
    // persistido endereços que o keyring atual não controla — corrige para os atuais.
    if (!pm.wallet || pm.wallet.address !== input.wallets.PAYMASTER_1.address) { pm.wallet = link(input.wallets.PAYMASTER_1); changed = true; }
    // knownWallets pré-populado: sem alertas de "nova carteira" durante a apresentação.
    pm.knownWallets = Array.from(new Set([...(pm.knownWallets ?? []), ...Object.values(input.wallets).map(w => w.address)]));
    const LABELS: Record<MesaRole, string> = { SELLER: 'Vendedor (demo)', BUYER: 'Comprador (demo)', PAYMASTER_2: 'Pay Master 2 (demo)' };
    for (const role of ['SELLER', 'BUYER', 'PAYMASTER_2'] as MesaRole[]) {
      const existing = Object.values(this.data.invites).find(i => i.payMasterId === pm.id && i.role === role);
      if (existing && existing.status === 'confirmed' && existing.wallet?.address === input.wallets[role].address) continue;
      const token = 'demo_' + role.toLowerCase();
      if (existing && existing.token !== token) delete this.data.invites[existing.token];
      this.data.invites[token] = { token, payMasterId: pm.id, role, network: 'multichain', label: LABELS[role], status: 'confirmed', wallet: link(input.wallets[role]), createdAt: this.now(), expiresAt: this.now() + 10 * 365 * 24 * HOUR };
      changed = true;
    }
    if (changed) this.write();
  }

  /** PM revoga/remove um convite (por papel ou por token). */
  revokeInvite(token: string | undefined, input: { role?: MesaRole; inviteToken?: string }): void {
    const s = this.session(token);
    const pm = this.pm(s.payMasterId);
    for (const [k, inv] of Object.entries(this.data.invites)) {
      if (inv.payMasterId !== pm.id) continue;
      if ((input.inviteToken && k === input.inviteToken) || (input.role && inv.role === input.role)) delete this.data.invites[k];
    }
    this.write();
  }
}
