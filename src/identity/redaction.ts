/**
 * Redação de dados pessoais para logs (§8). Nenhum log de aplicação pode conter nome,
 * e-mail, telefone, código OTP ou token. `redact` limpa objetos por nome de chave e por
 * padrão de valor; `containsPersonalData` alimenta o teste que falha se PII vazar em log.
 */

// Chaves cujo valor é sempre pessoal/sensível e nunca deve ir a log.
const SENSITIVE_KEY = /(^|_|\b)(fullname|name|nome|email|e-mail|phone|telefone|celular|code|otp|token|secret|password|senha|seed|mnemonic|privatekey|cpf|rg|passport|birth|dob|address|geo)($|_|\b)/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// Telefone como TOKEN isolado (lookarounds evitam casar dígitos embutidos em, ex.,
// um endereço de carteira "solana:mainnet:So1000...Addr", que é público e não é PII).
const PHONE_RE = /(?<![A-Za-z0-9:])\+?\d[\d ()\-.]{6,}\d(?![A-Za-z0-9])/g;
const REDACTED = '[REDACTED]';

/** Substitui padrões de e-mail/telefone dentro de uma string por [REDACTED]. */
function scrubString(s: string): string {
  return s.replace(EMAIL_RE, REDACTED).replace(PHONE_RE, m => (m.replace(/\D/g, '').length >= 8 ? REDACTED : m));
}

/** Clona `value` redigindo dados pessoais por chave e por padrão de valor. Seguro para logar. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return value;
}

/** Detecta PII crua (e-mail/telefone) numa string — usado em testes de log. */
export function containsPersonalData(s: string): boolean {
  EMAIL_RE.lastIndex = 0; PHONE_RE.lastIndex = 0;
  if (EMAIL_RE.test(s)) return true;
  const phones = s.match(PHONE_RE);
  return !!phones && phones.some(m => m.replace(/\D/g, '').length >= 8);
}
