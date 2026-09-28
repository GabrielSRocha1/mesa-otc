/**
 * TOTP (RFC 6238) sem dependências externas — usado pelo 2FA do Portal Pay Master.
 * Segredo em Base32 (RFC 4648), HMAC-SHA1, janela de 30s, 6 dígitos. Compatível com
 * Google Authenticator / Authy / 1Password via entrada manual da chave ou otpauth://.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Segredo Base32 (padrão: 20 bytes = 160 bits, recomendado pela RFC 4226). */
export function generateTotpSecret(bytes = 20): string { return base32Encode(randomBytes(bytes)); }

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Código corrente para um segredo (usado em testes/depuração). */
export function totpCode(secret: string, nowMs: number, stepSec = 30): string {
  return hotp(secret, Math.floor(nowMs / 1000 / stepSec));
}

/** Verifica um código com tolerância de ±`window` passos (padrão ±1 = ±30s de clock skew). */
export function verifyTotp(secret: string, code: string, nowMs: number, window = 1, stepSec = 30): boolean {
  const clean = (code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean) || !secret) return false;
  const counter = Math.floor(nowMs / 1000 / stepSec);
  const b = Buffer.from(clean);
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(secret, counter + w));
    if (expected.length === b.length && timingSafeEqual(expected, b)) return true;
  }
  return false;
}

/** URI otpauth:// para QR / entrada manual em apps autenticadores. */
export function otpauthUri(opts: { secret: string; label: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.label)}`;
  const params = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
