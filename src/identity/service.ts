/**
 * IdentityService — orquestra a identidade mínima (§2), a verificação de contato por OTP
 * (§10), a elegibilidade (§2), o snapshot por operação (§2/§6), a detecção de confundíveis,
 * as trocas controladas de carteira/contato (§4) e o crypto-shredding (§8).
 *
 * Invariantes: só os 4 elementos admitidos são armazenados; nome/e-mail/telefone sempre
 * cifrados; buscas por índice cego; nenhuma PII em payload de auditoria (só referências).
 */
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import type { FieldCrypto } from './crypto.js';
import type { OtpManager } from './otp.js';
import { SlidingWindowLimiter } from './otp.js';
import type { IdentityStore } from './store.js';
import {
  validateName, validateEmail, validatePhoneE164, maskEmail, maskPhone,
  namesConfusable, phoneCountryAllowed,
} from './normalize.js';
import type {
  AccountRow, PublicIdentity, IdentitySnapshot, ConfusableAlert, VerificationLevel,
} from './types.js';

export interface IdentityAudit {
  append(e: { actorType: 'user' | 'operator' | 'system'; actorId: string; category: string; dealId: string | null; payload: Record<string, unknown> }): Promise<unknown>;
}

export interface IdentityConfig {
  reverifyDays?: number;              // CONTACT_REVERIFY_DAYS (padrão 180)
  allowedCallingCodes?: string[];     // allowlist E.164 anti SMS-pumping
  smsDailyCap?: number;               // teto de SMS/dia (custo)
  walletRecoveryGraceMs?: number;     // carência de troca por perda (padrão 72h)
}

const CAIP10_RE = /^[-a-z0-9]{3,8}:[-a-zA-Z0-9]{1,32}:[^\s:]{8,}$/;
const DAY = 86_400_000;

export interface IdentityDeps {
  store: IdentityStore;
  crypto: FieldCrypto;
  emailOtp: OtpManager;
  phoneOtp: OtpManager;
  now?: () => number;
  audit?: IdentityAudit;
  config?: IdentityConfig;
}

interface ChallengeMeta { userId: string; kind: 'email' | 'phone'; value: string; index: string }

export class IdentityService {
  private readonly store: IdentityStore;
  private readonly crypto: FieldCrypto;
  private readonly emailOtp: OtpManager;
  private readonly phoneOtp: OtpManager;
  private readonly now: () => number;
  private readonly audit?: IdentityAudit;
  private readonly reverifyMs: number;
  private readonly allowedCodes: string[];
  private readonly smsLimiter: SlidingWindowLimiter;
  private readonly graceMs: number;
  private readonly challenges = new Map<string, ChallengeMeta>();
  private readonly recovery = new Map<string, number>(); // userId → readyAt

  constructor(deps: IdentityDeps) {
    this.store = deps.store; this.crypto = deps.crypto;
    this.emailOtp = deps.emailOtp; this.phoneOtp = deps.phoneOtp;
    this.now = deps.now ?? (() => Date.now());
    this.audit = deps.audit;
    const c = deps.config ?? {};
    this.reverifyMs = (c.reverifyDays ?? 180) * DAY;
    this.allowedCodes = c.allowedCallingCodes ?? ['1', '33', '34', '39', '44', '49', '351', '52', '54', '55', '56', '57', '595', '598'];
    this.smsLimiter = new SlidingWindowLimiter(DAY, c.smsDailyCap ?? 1000);
    this.graceMs = c.walletRecoveryGraceMs ?? 72 * 3600_000;
  }

  private log(category: string, actorId: string, payload: Record<string, unknown>): void {
    // Auditoria recebe apenas referências (userId/índices/mascarados) — nunca PII crua.
    void this.audit?.append({ actorType: 'user', actorId, category, dealId: null, payload });
  }
  private require(id: string): AccountRow {
    const a = this.store.get(id);
    if (!a) throw new DomainError('INVALID_INPUT', 'Conta inexistente');
    if (a.status !== 'active') throw new DomainError('FORBIDDEN', 'Conta indisponível');
    return a;
  }

  /* ---------- Criação de conta (carteira já provada pelo desafio de login) ---------- */
  createAccount(input: { walletCaip10: string }): { userId: string } {
    const walletCaip10 = input.walletCaip10.trim();
    if (!CAIP10_RE.test(walletCaip10)) throw new DomainError('WALLET_INVALID', 'Endereço CAIP-10 inválido');
    if (this.findAccountByWallet(walletCaip10)) throw new DomainError('VERSION_CONFLICT', 'Carteira já vinculada a uma conta');
    const at = this.now();
    const row: AccountRow = {
      id: 'usr_' + randomUUID(), status: 'active', verificationLevel: 'BASIC',
      walletCaip10, walletVerifiedAt: at,
      fullNameEnc: null, fullNameSetAt: null,
      emailEnc: null, emailIndex: null, emailVerifiedAt: null,
      phoneEnc: null, phoneIndex: null, phoneVerifiedAt: null,
      wrappedDek: this.crypto.newUserKey(), settlementAddresses: [], createdAt: at, updatedAt: at,
    };
    this.store.insert(row);
    this.log('identity.account.created', row.id, { walletCaip10 });
    return { userId: row.id };
  }

  /** Cria a conta se ainda não existir para a carteira; senão devolve a existente (idempotente). */
  ensureAccount(walletCaip10: string): { userId: string; created: boolean } {
    const existing = this.store.getByWallet(walletCaip10.trim());
    if (existing) return { userId: existing.id, created: false };
    return { userId: this.createAccount({ walletCaip10 }).userId, created: true };
  }

  /** Visão própria segura (nome visível ao dono; e-mail/telefone mascarados) + elegibilidade e endereços. */
  describe(userId: string): {
    userId: string; verificationLevel: VerificationLevel; walletCaip10: string;
    fullName: string; hasName: boolean;
    email: { verified: boolean; verifiedAt: number | null; masked: string };
    phone: { verified: boolean; verifiedAt: number | null; masked: string };
    settlementAddresses: { caip10: string; verifiedAt: number }[];
    eligibility: { eligible: boolean; reasons: string[] };
  } {
    const a = this.require(userId);
    const v = this.publicView(userId);
    return {
      userId: a.id, verificationLevel: a.verificationLevel, walletCaip10: a.walletCaip10,
      fullName: v.fullName, hasName: !!a.fullNameSetAt,
      email: { verified: !!a.emailVerifiedAt, verifiedAt: a.emailVerifiedAt, masked: v.emailMasked },
      phone: { verified: !!a.phoneVerifiedAt, verifiedAt: a.phoneVerifiedAt, masked: v.phoneMasked },
      settlementAddresses: a.settlementAddresses,
      eligibility: this.eligibility(userId),
    };
  }

  /* ---------- Nome completo ---------- */
  setFullName(userId: string, rawName: string): void {
    const a = this.require(userId);
    const name = validateName(rawName);
    this.store.update(userId, { fullNameEnc: this.crypto.encryptField(a.wrappedDek!, name), fullNameSetAt: this.now(), updatedAt: this.now() });
    this.log('identity.name.set', userId, {});
  }

  /* ---------- Verificação de e-mail ---------- */
  async startEmailVerification(userId: string, rawEmail: string): Promise<{ challengeId: string; expiresAt: number; masked: string }> {
    this.require(userId);
    const email = validateEmail(rawEmail);
    const index = this.crypto.blindIndex(email);
    const owner = this.store.findByEmailIndex(index);
    if (owner && owner.id !== userId) throw new DomainError('VERSION_CONFLICT', 'E-mail já em uso');
    const { challengeId, expiresAt } = await this.emailOtp.issue(email, 'verify-email');
    this.challenges.set(challengeId, { userId, kind: 'email', value: email, index });
    this.log('identity.otp.sent', userId, { channel: 'email' });
    return { challengeId, expiresAt, masked: maskEmail(email) };
  }
  confirmEmail(userId: string, challengeId: string, code: string): void {
    this.emailOtp.verify(challengeId, code); // lança INVALID/RATE_LIMITED
    const meta = this.challenges.get(challengeId);
    if (!meta || meta.userId !== userId || meta.kind !== 'email') throw new DomainError('INVALID_INPUT', 'Código inválido ou expirado');
    this.challenges.delete(challengeId);
    const owner = this.store.findByEmailIndex(meta.index);
    if (owner && owner.id !== userId) throw new DomainError('VERSION_CONFLICT', 'E-mail já em uso');
    const a = this.require(userId);
    this.store.update(userId, { emailEnc: this.crypto.encryptField(a.wrappedDek!, meta.value), emailIndex: meta.index, emailVerifiedAt: this.now(), updatedAt: this.now() });
    this.log('identity.email.verified', userId, {});
  }

  /* ---------- Verificação de telefone (allowlist + teto diário de SMS) ---------- */
  async startPhoneVerification(userId: string, rawPhone: string): Promise<{ challengeId: string; expiresAt: number; masked: string }> {
    this.require(userId);
    const phone = validatePhoneE164(rawPhone);
    if (!phoneCountryAllowed(phone, this.allowedCodes)) throw new DomainError('FORBIDDEN', 'País não habilitado para verificação por SMS');
    const index = this.crypto.blindIndex(phone);
    const owner = this.store.findByPhoneIndex(index);
    if (owner && owner.id !== userId) throw new DomainError('VERSION_CONFLICT', 'Telefone já em uso');
    if (!this.smsLimiter.take('sms:global', this.now())) throw new DomainError('RATE_LIMITED', 'Limite diário de SMS atingido. Tente novamente amanhã.');
    const { challengeId, expiresAt } = await this.phoneOtp.issue(phone, 'verify-phone');
    this.challenges.set(challengeId, { userId, kind: 'phone', value: phone, index });
    this.log('identity.otp.sent', userId, { channel: 'sms' });
    return { challengeId, expiresAt, masked: maskPhone(phone) };
  }
  confirmPhone(userId: string, challengeId: string, code: string): void {
    this.phoneOtp.verify(challengeId, code);
    const meta = this.challenges.get(challengeId);
    if (!meta || meta.userId !== userId || meta.kind !== 'phone') throw new DomainError('INVALID_INPUT', 'Código inválido ou expirado');
    this.challenges.delete(challengeId);
    const owner = this.store.findByPhoneIndex(meta.index);
    if (owner && owner.id !== userId) throw new DomainError('VERSION_CONFLICT', 'Telefone já em uso');
    const a = this.require(userId);
    this.store.update(userId, { phoneEnc: this.crypto.encryptField(a.wrappedDek!, meta.value), phoneIndex: meta.index, phoneVerifiedAt: this.now(), updatedAt: this.now() });
    this.log('identity.phone.verified', userId, {});
  }

  /* ---------- Elegibilidade (§2) ---------- */
  eligibility(userId: string): { eligible: boolean; reasons: string[] } {
    const a = this.store.get(userId);
    const reasons: string[] = [];
    if (!a || a.status !== 'active') return { eligible: false, reasons: ['conta indisponível'] };
    const fresh = (t: number | null): boolean => t != null && this.now() - t <= this.reverifyMs;
    if (!a.walletVerifiedAt) reasons.push('carteira não verificada');
    if (!a.fullNameSetAt) reasons.push('nome não informado');
    if (!a.emailVerifiedAt) reasons.push('e-mail não verificado'); else if (!fresh(a.emailVerifiedAt)) reasons.push('e-mail precisa de reverificação');
    if (!a.phoneVerifiedAt) reasons.push('telefone não verificado'); else if (!fresh(a.phoneVerifiedAt)) reasons.push('telefone precisa de reverificação');
    return { eligible: reasons.length === 0, reasons };
  }
  assertEligible(userId: string): void {
    const r = this.eligibility(userId);
    if (!r.eligible) throw new DomainError('NOT_ELIGIBLE', `Participante inelegível: ${r.reasons.join('; ')}`);
  }

  /* ---------- Endereços de liquidação (prova de posse na própria rede) ---------- */
  addSettlementAddress(userId: string, caip10: string, proofValid: boolean): void {
    const a = this.require(userId);
    const addr = caip10.trim();
    if (!CAIP10_RE.test(addr)) throw new DomainError('WALLET_INVALID', 'Endereço CAIP-10 inválido');
    if (!proofValid) throw new DomainError('WALLET_INVALID', 'Prova de posse ausente ou inválida para o endereço');
    const other = this.findAccountByWallet(addr);
    if (other && other.id !== userId) throw new DomainError('VERSION_CONFLICT', 'Endereço já vinculado a outra conta');
    if (a.walletCaip10 === addr || a.settlementAddresses.some(s => s.caip10 === addr)) return;
    this.store.update(userId, { settlementAddresses: [...a.settlementAddresses, { caip10: addr, verifiedAt: this.now() }], updatedAt: this.now() });
    this.log('identity.wallet.linked', userId, { caip10: addr });
  }

  /* ---------- Visões (mascarada e snapshot) ---------- */
  publicView(userId: string, role?: string): PublicIdentity {
    const a = this.require(userId);
    const email = a.emailEnc ? this.crypto.decryptField(a.wrappedDek, a.emailEnc) : '';
    const phone = a.phoneEnc ? this.crypto.decryptField(a.wrappedDek, a.phoneEnc) : '';
    return {
      userId: a.id, role, walletCaip10: a.walletCaip10,
      fullName: a.fullNameEnc ? this.crypto.decryptField(a.wrappedDek, a.fullNameEnc) : '',
      emailMasked: email ? maskEmail(email) : '', phoneMasked: phone ? maskPhone(phone) : '',
      emailVerifiedAt: a.emailVerifiedAt, phoneVerifiedAt: a.phoneVerifiedAt, verificationLevel: a.verificationLevel,
    };
  }

  /**
   * Congela o snapshot de identidade de todos os participantes de uma operação e detecta
   * nomes confundíveis. Valida: 3–4 participantes, usuários e carteiras distintos, todos
   * elegíveis. "Ninguém em dois papéis" e "PM01 ≠ PM02" decorrem de userIds distintos.
   */
  buildOperationSnapshot(participants: { role: string; userId: string }[]): { snapshots: IdentitySnapshot[]; confusableAlerts: ConfusableAlert[] } {
    if (participants.length < 3 || participants.length > 4) throw new DomainError('INVALID_INPUT', 'Operação exige 3 ou 4 participantes');
    const userIds = new Set<string>();
    for (const p of participants) { if (userIds.has(p.userId)) throw new DomainError('INVALID_INPUT', 'Mesmo usuário em mais de um papel'); userIds.add(p.userId); }
    const snapshots: IdentitySnapshot[] = [];
    const wallets = new Set<string>();
    const names: { userId: string; role: string; fullName: string }[] = [];
    for (const p of participants) {
      this.assertEligible(p.userId);
      const a = this.require(p.userId);
      if (wallets.has(a.walletCaip10)) throw new DomainError('INVALID_INPUT', 'Carteiras dos participantes devem ser distintas');
      wallets.add(a.walletCaip10);
      const fullName = this.crypto.decryptField(a.wrappedDek, a.fullNameEnc!);
      names.push({ userId: p.userId, role: p.role, fullName });
      snapshots.push({ role: p.role, userId: p.userId, walletCaip10: a.walletCaip10, fullName, emailVerifiedAt: a.emailVerifiedAt, phoneVerifiedAt: a.phoneVerifiedAt, verificationLevel: a.verificationLevel });
    }
    const confusableAlerts: ConfusableAlert[] = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const ni = names[i]!, nj = names[j]!;
      if (namesConfusable(ni.fullName, nj.fullName)) confusableAlerts.push({ a: { userId: ni.userId, role: ni.role }, b: { userId: nj.userId, role: nj.role } });
    }
    if (confusableAlerts.length) this.log('security.confusable_names', participants[0]!.userId, { pairs: confusableAlerts.length });
    return { snapshots, confusableAlerts };
  }

  /* ---------- Trocas controladas (§4) ---------- */
  /** Troca de contato (e-mail/telefone) com a carteira disponível — bloqueada durante operação ativa. */
  changeContact(userId: string, kind: 'email' | 'phone', proofs: { walletSigOk: boolean; newContactOtpOk: boolean; hasActiveOperation: boolean }): void {
    this.require(userId);
    if (proofs.hasActiveOperation) throw new DomainError('FORBIDDEN', 'Conta com operação ativa não pode trocar contato');
    if (!proofs.walletSigOk) throw new DomainError('FORBIDDEN', 'Assinatura da carteira exigida');
    if (!proofs.newContactOtpOk) throw new DomainError('FORBIDDEN', 'OTP no novo contato exigido');
    this.log(kind === 'email' ? 'identity.email.changed' : 'identity.phone.changed', userId, {});
  }
  /** Troca de carteira com a atual disponível: assinatura atual + nova + OTP de e-mail. */
  changeWalletWithCurrent(userId: string, newCaip10: string, proofs: { currentSigOk: boolean; newSigOk: boolean; emailOtpOk: boolean; hasActiveOperation: boolean }): void {
    const a = this.require(userId);
    if (proofs.hasActiveOperation) throw new DomainError('FORBIDDEN', 'Conta com operação ativa não pode trocar carteira');
    if (!CAIP10_RE.test(newCaip10.trim())) throw new DomainError('WALLET_INVALID', 'Endereço CAIP-10 inválido');
    if (!proofs.currentSigOk || !proofs.newSigOk || !proofs.emailOtpOk) throw new DomainError('FORBIDDEN', 'Exige assinatura da carteira atual, da nova e OTP de e-mail');
    if (this.findAccountByWallet(newCaip10.trim())) throw new DomainError('VERSION_CONFLICT', 'Carteira já vinculada a uma conta');
    this.store.update(userId, { walletCaip10: newCaip10.trim(), walletVerifiedAt: this.now(), updatedAt: this.now() });
    void a;
    this.log('identity.wallet.changed', userId, { mode: 'current-available' });
  }
  /** Perda de carteira: OTP e-mail + OTP telefone + carência de 72h antes de concluir. */
  initiateLostWalletRecovery(userId: string, proofs: { emailOtpOk: boolean; phoneOtpOk: boolean; hasActiveOperation: boolean }): { readyAt: number } {
    this.require(userId);
    if (proofs.hasActiveOperation) throw new DomainError('FORBIDDEN', 'Conta com operação ativa não pode iniciar recuperação');
    if (!proofs.emailOtpOk || !proofs.phoneOtpOk) throw new DomainError('FORBIDDEN', 'Exige OTP de e-mail e de telefone');
    const readyAt = this.now() + this.graceMs;
    this.recovery.set(userId, readyAt);
    this.log('identity.wallet.recovery.initiated', userId, { readyAt });
    return { readyAt };
  }
  completeLostWalletRecovery(userId: string, newCaip10: string): void {
    this.require(userId);
    const readyAt = this.recovery.get(userId);
    if (readyAt == null) throw new DomainError('FORBIDDEN', 'Nenhuma recuperação em andamento');
    if (this.now() < readyAt) throw new DomainError('FORBIDDEN', 'Período de carência de 72h ainda não decorrido');
    if (!CAIP10_RE.test(newCaip10.trim())) throw new DomainError('WALLET_INVALID', 'Endereço CAIP-10 inválido');
    if (this.findAccountByWallet(newCaip10.trim())) throw new DomainError('VERSION_CONFLICT', 'Carteira já vinculada a uma conta');
    this.recovery.delete(userId);
    this.store.update(userId, { walletCaip10: newCaip10.trim(), walletVerifiedAt: this.now(), updatedAt: this.now() });
    this.log('identity.wallet.changed', userId, { mode: 'lost-recovery' });
  }
  /** Cancela um pedido de recuperação (link "não fui eu" das notificações). */
  cancelLostWalletRecovery(userId: string): void { if (this.recovery.delete(userId)) this.log('identity.wallet.recovery.cancelled', userId, {}); }

  /* ---------- Crypto-shredding (§8) ---------- */
  cryptoShred(userId: string): void {
    const a = this.store.get(userId);
    if (!a) return;
    this.store.update(userId, { wrappedDek: null, status: 'shredded', updatedAt: this.now() });
    this.log('identity.account.shredded', userId, {});
    void a;
  }

  /**
   * Resolve um contato exato (e-mail OU telefone) para o índice cego e o dono (se houver).
   * Usado pelas salas para casar convite↔conta sem busca parcial e sem vazar existência.
   */
  lookupByContact(contact: { email?: string; phone?: string }): { kind: 'email' | 'phone'; index: string; userId: string | null } {
    if (contact.email) { const v = validateEmail(contact.email); const index = this.crypto.blindIndex(v); return { kind: 'email', index, userId: this.store.findByEmailIndex(index)?.id ?? null }; }
    if (contact.phone) { const v = validatePhoneE164(contact.phone); const index = this.crypto.blindIndex(v); return { kind: 'phone', index, userId: this.store.findByPhoneIndex(index)?.id ?? null }; }
    throw new DomainError('INVALID_INPUT', 'Informe e-mail ou telefone');
  }
  /** Índices cegos de contato verificado do usuário (para casar o caminho de onboarding→aceite). */
  contactIndexes(userId: string): string[] {
    const a = this.store.get(userId); if (!a) return [];
    return [a.emailVerifiedAt ? a.emailIndex : null, a.phoneVerifiedAt ? a.phoneIndex : null].filter((x): x is string => !!x);
  }
  /** Carteira de identidade (CAIP-10) do usuário. */
  walletOf(userId: string): string { return this.require(userId).walletCaip10; }

  /* ---------- utilidades ---------- */
  private findAccountByWallet(caip10: string): AccountRow | undefined {
    const direct = this.store.getByWallet(caip10);
    if (direct) return direct;
    return this.store.all().find(a => a.settlementAddresses.some(s => s.caip10 === caip10));
  }
  verificationLevelOf(userId: string): VerificationLevel { return this.require(userId).verificationLevel; }
}
