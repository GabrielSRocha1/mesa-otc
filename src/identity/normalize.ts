/**
 * Normalização, validação e mascaramento dos 3 dados pessoais admitidos (§2):
 * nome completo, e-mail, telefone. Também o "esqueleto" de confundíveis (Unicode TR39)
 * usado para detectar impersonação por nome parecido (ex.: "João Silva" vs "Joao SiIva").
 */
import { DomainError } from '../domain/errors.js';

/* ---------- Nome completo ---------- */
// Permitido no nome: letras Unicode, marcas de acento, espaço, hífen e apóstrofo (reto ou tipográfico).
const NAME_ALLOWED = /^[\p{L}\p{M} '’-]+$/u;

/** NFC + trim + colapso de espaços. Não valida (use validateName). */
export function normalizeName(raw: string): string {
  return (raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Normaliza e valida o nome completo. Lança DomainError se inválido. Devolve o nome normalizado. */
export function validateName(raw: string): string {
  const name = normalizeName(raw);
  if (name.length < 3 || name.length > 120) throw new DomainError('INVALID_INPUT', 'Nome deve ter entre 3 e 120 caracteres');
  if (!NAME_ALLOWED.test(name)) throw new DomainError('INVALID_INPUT', 'Nome contém caracteres não permitidos');
  const words = name.split(' ').filter(w => w.replace(/['’-]/g, '').length >= 1);
  if (words.length < 2) throw new DomainError('INVALID_INPUT', 'Informe nome e sobrenome (2+ palavras)');
  return name;
}

/* ---------- E-mail ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normaliza e valida e-mail (lowercase/trim). O valor normalizado alimenta o blind index. */
export function validateEmail(raw: string): string {
  const email = (raw ?? '').trim().toLowerCase();
  if (email.length < 5 || email.length > 160 || !EMAIL_RE.test(email)) throw new DomainError('INVALID_INPUT', 'E-mail inválido');
  return email;
}

/** Mascara e-mail para exibição a terceiros: joao@gmail.com → j***@g***.com */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at), domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  const dHead = domain.slice(0, 1) || '*';
  return `${local.slice(0, 1)}***@${dHead}***${tld}`;
}

/* ---------- Telefone (E.164) ---------- */
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Valida telefone E.164 (+ e 8–15 dígitos). Devolve normalizado (só +dígitos). */
export function validatePhoneE164(raw: string): string {
  const phone = (raw ?? '').replace(/[\s()\-.]/g, '');
  if (!E164_RE.test(phone)) throw new DomainError('INVALID_INPUT', 'Telefone deve estar em formato E.164 (ex.: +5511999998888)');
  return phone;
}

/** Mascara telefone: +5511999991234 → +55 •• •••••-1234 */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length < 6) return '+••';
  return `+${d.slice(0, 2)} •• •••••-${d.slice(-4)}`;
}

/** Prefixo de país (dígitos após o +) casa com algum código da allowlist? */
export function phoneCountryAllowed(phone: string, allowedCallingCodes: string[]): boolean {
  const d = phone.replace(/\D/g, '');
  return allowedCallingCodes.some(code => d.startsWith(code.replace(/\D/g, '')));
}

/* ---------- Esqueleto de confundíveis (Unicode TR39, pragmático) ---------- */
// Mapa de homoglifos → protótipo canônico (minúsculo). Aplicado ANTES do casefold para
// preservar confusões de caixa (I↔l). Cobre latim/cirílico/grego comuns e dígitos-letra.
const CONFUSABLE: Record<string, string> = {
  I: 'l', l: 'l', '1': 'l', '|': 'l', 'ı': 'l', 'Ɩ': 'l', 'ǀ': 'l', 'ł': 'l',
  '0': 'o', O: 'o', o: 'o', 'О': 'o', 'о': 'o', 'Ο': 'o', 'ο': 'o', 'Ø': 'o',
  S: 's', s: 's', 'Ѕ': 's', 'ѕ': 's', '5': 's', 'ʂ': 's',
  a: 'a', A: 'a', 'а': 'a', 'А': 'a', 'ɑ': 'a', 'α': 'a',
  e: 'e', E: 'e', 'е': 'e', 'Е': 'e', 'ε': 'e', '3': 'e',
  c: 'c', C: 'c', 'с': 'c', 'С': 'c', 'ϲ': 'c',
  p: 'p', P: 'p', 'р': 'p', 'Р': 'p', 'ρ': 'p',
  x: 'x', X: 'x', 'х': 'x', 'Х': 'x', '×': 'x',
  y: 'y', Y: 'y', 'у': 'y', 'У': 'y', 'γ': 'y',
  i: 'i', 'і': 'i', 'í': 'i',
  n: 'n', 'п': 'n',
  b: 'b', B: 'b', 'Ь': 'b', '8': 'b',
  g: 'g', q: 'g', '9': 'g',
  d: 'd', D: 'd', 'ԁ': 'd',
  h: 'h', H: 'h', 'Н': 'h', 'н': 'h',
  k: 'k', K: 'k', 'К': 'k', 'к': 'k',
  m: 'm', M: 'm', 'М': 'm', 'м': 'm',
  t: 't', T: 't', 'т': 't',
  u: 'u', U: 'u', 'υ': 'u', v: 'u', V: 'u', w: 'w', W: 'w',
  r: 'r', R: 'r', f: 'f', F: 'f', j: 'j', J: 'j', z: 'z', Z: 'z',
};

/** Esqueleto de confundíveis: colapsa homoglifos e caixa; ignora acentos, espaços e pontuação. */
export function confusableSkeleton(name: string): string {
  const stripped = name.normalize('NFKD').replace(/\p{M}/gu, ''); // remove acentos
  let out = '';
  for (const ch of stripped) {
    const mapped = CONFUSABLE[ch];
    if (mapped) out += mapped;
    else if (/\p{L}/u.test(ch)) out += ch.toLowerCase();
    // demais (espaços, hífen, apóstrofo, dígitos não mapeados) são descartados
  }
  return out.replace(/rn/g, 'm'); // bigrama clássico rn↔m
}

/** Dois nomes são visualmente confundíveis (mesmo esqueleto TR39). Inclui nomes idênticos. */
export function namesConfusable(a: string, b: string): boolean {
  const sa = confusableSkeleton(a), sb = confusableSkeleton(b);
  return sa.length > 0 && sa === sb;
}
