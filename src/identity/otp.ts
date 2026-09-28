/**
 * OTP de verificação de contato (§2, §10). Códigos de 6 dígitos CSPRNG, guardados apenas
 * como HMAC, comparados em tempo constante, invalidados no uso ou no bloqueio. Rate limit
 * em janela deslizante para envio e lockout após N tentativas. Canais (e-mail/SMS) atrás
 * de interface com implementações fake para teste.
 *
 * IMPORTANTE: OTP NÃO é fator de login (§3). Serve para verificar posse de contato,
 * notificações e recuperação controlada.
 */
import { randomBytes } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import { constantTimeEqualHex, generateOtp, type FieldCrypto } from './crypto.js';

/** Rate limiter token-bucket em janela deslizante (em memória; em prod, Redis). */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number, private readonly max: number) {}
  /** Registra e devolve true se dentro do limite; false se excedido. */
  take(key: string, now: number): boolean {
    const arr = (this.hits.get(key) ?? []).filter(t => t > now - this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr); return true;
  }
  reset(key: string): void { this.hits.delete(key); }
}

/** Mensagem entregue ao dono do contato. Contém apenas o código e a finalidade — nunca dados da operação. */
export interface OtpMessage { to: string; code: string; purpose: string }
export interface OtpChannel { name(): 'email' | 'sms'; send(msg: OtpMessage): Promise<void> }

/** Canal fake de e-mail: captura envios para teste (nunca usar em produção). */
export class FakeEmailChannel implements OtpChannel {
  readonly sent: OtpMessage[] = [];
  name(): 'email' { return 'email'; }
  async send(msg: OtpMessage): Promise<void> { this.sent.push(msg); }
  last(): OtpMessage | undefined { return this.sent[this.sent.length - 1]; }
}
/** Canal fake de SMS. */
export class FakeSmsChannel implements OtpChannel {
  readonly sent: OtpMessage[] = [];
  name(): 'sms' { return 'sms'; }
  async send(msg: OtpMessage): Promise<void> { this.sent.push(msg); }
  last(): OtpMessage | undefined { return this.sent[this.sent.length - 1]; }
}

interface Pending { id: string; hash: string; expiresAt: number; attempts: number; purpose: string; to: string }

export interface OtpOptions { ttlMs?: number; maxAttempts?: number; sendsPerWindow?: number; sendWindowMs?: number }

/** Gerencia emissão e verificação de OTP para UM canal. */
export class OtpManager {
  private pending = new Map<string, Pending>();
  private readonly sendLimiter: SlidingWindowLimiter;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  constructor(private readonly crypto: FieldCrypto, private readonly channel: OtpChannel, private readonly now: () => number, opts: OtpOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.sendLimiter = new SlidingWindowLimiter(opts.sendWindowMs ?? 15 * 60_000, opts.sendsPerWindow ?? 3);
  }

  channelName(): 'email' | 'sms' { return this.channel.name(); }

  /** Emite um OTP para o contato `to` (rate-limited). Invalida OTPs anteriores do mesmo contato. */
  async issue(to: string, purpose: string): Promise<{ challengeId: string; expiresAt: number }> {
    const now = this.now();
    if (!this.sendLimiter.take(`send:${to}`, now)) throw new DomainError('RATE_LIMITED', 'Muitos códigos solicitados. Aguarde alguns minutos.');
    for (const [k, p] of this.pending) if (p.to === to) this.pending.delete(k);
    const code = generateOtp(6);
    const id = randomBytes(18).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.pending.set(id, { id, hash: this.crypto.hashOtp(code), expiresAt, attempts: 0, purpose, to });
    await this.channel.send({ to, code, purpose });
    return { challengeId: id, expiresAt };
  }

  /**
   * Verifica um código. Mensagem de erro uniforme (anti-enumeração). Após `maxAttempts`
   * erros o desafio é bloqueado e destruído. Sucesso consome o desafio (uso único).
   */
  verify(challengeId: string, code: string): { to: string; purpose: string } {
    const now = this.now();
    const p = this.pending.get(challengeId);
    const invalid = new DomainError('INVALID_INPUT', 'Código inválido ou expirado');
    if (!p) throw invalid;
    if (now > p.expiresAt) { this.pending.delete(challengeId); throw invalid; }
    p.attempts++;
    const ok = constantTimeEqualHex(this.crypto.hashOtp(code), p.hash);
    if (!ok) {
      if (p.attempts >= this.maxAttempts) { this.pending.delete(challengeId); throw new DomainError('RATE_LIMITED', 'Código bloqueado após muitas tentativas. Solicite um novo.'); }
      throw invalid;
    }
    this.pending.delete(challengeId);
    return { to: p.to, purpose: p.purpose };
  }
}
