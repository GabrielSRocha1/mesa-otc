/**
 * Criptografia do módulo de identidade (VERUM OTC · §8 privacidade).
 *
 * Cifragem em nível de campo com envelope encryption: uma DEK (Data Encryption Key)
 * por usuário, protegida (wrapped) por uma master key exposta atrás da interface `Kms`.
 * Em produção a `Kms` seria um adaptador para AWS KMS/GCP KMS/HSM; aqui há uma
 * implementação local (`LocalKms`) com a MESMA interface, para dev e testes.
 *
 * Blind index (HMAC-SHA256, chave separada) permite busca exata de e-mail/telefone
 * normalizados sem decifrar. Código forense (HMAC) identifica sessão em marca d'água
 * sem expor dados pessoais. Crypto-shredding: destruir a DEK torna os campos ilegíveis
 * mantendo a trilha de auditoria íntegra.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Interface de um Key Management Service. Envolve/desenvolve DEKs; a master key nunca sai do KMS. */
export interface Kms {
  /** Gera uma DEK de 256 bits e devolve a chave em claro (uso imediato) + o blob protegido para armazenar. */
  generateDek(): { dek: Buffer; wrapped: string };
  /** Desenvolve um blob previamente protegido. Lança se adulterado. */
  unwrapDek(wrapped: string): Buffer;
}

const GCM = 'aes-256-gcm';

function seal(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(GCM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // formato: base64(iv).base64(tag).base64(ct)
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}
function open(sealed: string, key: Buffer): Buffer {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new Error('ciphertext malformado');
  const [ivB, tagB, ctB] = parts as [string, string, string];
  const decipher = createDecipheriv(GCM, key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]);
}

/** KMS local: uma master key de 256 bits protege (wrap) cada DEK via AES-256-GCM. */
export class LocalKms implements Kms {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('master key deve ter 32 bytes');
  }
  generateDek(): { dek: Buffer; wrapped: string } {
    const dek = randomBytes(32);
    return { dek, wrapped: seal(dek, this.masterKey) };
  }
  unwrapDek(wrapped: string): Buffer {
    const dek = open(wrapped, this.masterKey);
    if (dek.length !== 32) throw new Error('DEK inválida');
    return dek;
  }
}

/** Conjunto de chaves do módulo, com separação de domínio por finalidade. */
export interface IdentityKeys { kms: Kms; indexKey: Buffer; forensicKey: Buffer; otpKey: Buffer }

/**
 * Deriva as chaves de dev a partir de um segredo mestre (hex) via HKDF com rótulos
 * distintos (separação de domínio). Em produção cada chave vem do KMS/secret manager.
 */
export function deriveDevKeys(masterSecretHex: string): IdentityKeys {
  const ikm = Buffer.from(masterSecretHex, 'hex');
  if (ikm.length < 16) throw new Error('IDENTITY_MASTER_SECRET muito curto (>=16 bytes hex)');
  const d = (label: string): Buffer => Buffer.from(hkdfSync('sha256', ikm, Buffer.from('verum-otc-identity'), label, 32));
  return { kms: new LocalKms(d('kms-master')), indexKey: d('blind-index'), forensicKey: d('forensic'), otpKey: d('otp') };
}

/** Serviço de cifragem de campo por usuário (envelope). Uma instância por processo. */
export class FieldCrypto {
  constructor(private readonly keys: IdentityKeys) {}

  /** Cria uma DEK nova para um usuário; devolve o blob protegido a ser persistido. */
  newUserKey(): string { return this.keys.kms.generateDek().wrapped; }

  /** Cifra um valor de campo sob a DEK (protegida) do usuário. */
  encryptField(wrappedDek: string, plaintext: string): string {
    const dek = this.keys.kms.unwrapDek(wrappedDek);
    try { return seal(Buffer.from(plaintext, 'utf8'), dek); } finally { dek.fill(0); }
  }
  /** Decifra um campo. Lança se a DEK foi destruída (crypto-shredding) ou o dado adulterado. */
  decryptField(wrappedDek: string | null, sealed: string): string {
    if (!wrappedDek) throw new Error('DEK ausente (conta apagada por crypto-shredding)');
    const dek = this.keys.kms.unwrapDek(wrappedDek);
    try { return open(sealed, dek).toString('utf8'); } finally { dek.fill(0); }
  }

  /** Índice cego (HMAC) para busca exata sem decifrar. Determinístico para o mesmo valor normalizado. */
  blindIndex(normalizedValue: string): string {
    return createHmac('sha256', this.keys.indexKey).update(normalizedValue).digest('hex');
  }
  /** Código forense curto (8 chars) por sessão para marca d'água; o mapeamento fica só no servidor. */
  forensicCode(sessionId: string): string {
    const hex = createHmac('sha256', this.keys.forensicKey).update(sessionId).digest('hex');
    // 8 chars base32 (A-Z2-7) derivados dos primeiros bytes — legível e sem ambiguidade.
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let out = '';
    for (let i = 0; i < 8; i++) out += B32[parseInt(hex.slice(i * 2, i * 2 + 2), 16) & 31];
    return out;
  }
  /** HMAC de OTP para armazenamento (nunca guardar o código em claro). */
  hashOtp(code: string): string { return createHmac('sha256', this.keys.otpKey).update(code).digest('hex'); }
}

/** Gera um OTP numérico de `digits` dígitos com CSPRNG (sem viés). */
export function generateOtp(digits = 6): string {
  let out = '';
  for (let i = 0; i < digits; i++) out += String(randomInt(0, 10));
  return out;
}

/** Comparação de strings hex em tempo constante (anti-timing). */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** HMAC do IP para rate limit/auditoria sem guardar o IP em claro. */
export function hmacIp(key: Buffer, ip: string): string { return createHmac('sha256', key).update(ip).digest('hex'); }
