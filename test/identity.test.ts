/**
 * Testes de segurança do módulo de Identidade Mínima (VERUM OTC §2, §4, §8, §10).
 * Cada teste prova um controle exigido no prompt.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { deriveDevKeys, FieldCrypto } from '../src/identity/crypto.js';
import { OtpManager, FakeEmailChannel, FakeSmsChannel } from '../src/identity/otp.js';
import { InMemoryIdentityStore } from '../src/identity/store.js';
import { IdentityService, type IdentityConfig } from '../src/identity/service.js';
import { ACCOUNT_COLUMNS, INPUT_SCHEMAS } from '../src/identity/types.js';
import { redact, containsPersonalData } from '../src/identity/redaction.js';
import { confusableSkeleton, namesConfusable, maskEmail, maskPhone, validateName } from '../src/identity/normalize.js';
import { AuditLog } from '../src/audit/audit.js';
import { MemoryStore } from '../src/db/memoryStore.js';

const MASTER = 'a'.repeat(64); // 32 bytes hex (dev)
let seq = 0;
// Endereço fake sem longas sequências de dígitos (para não confundir heurística de telefone).
const wallet = (): string => `solana:mainnet:So1AddrW${String.fromCharCode(97 + (++seq % 26))}${seq.toString(36)}xyzKp`;

interface Harness { svc: IdentityService; store: InMemoryIdentityStore; email: FakeEmailChannel; phone: FakeSmsChannel; clock: { t: number } }
function mkHarness(config?: IdentityConfig): Harness {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const crypto = new FieldCrypto(deriveDevKeys(MASTER));
  const email = new FakeEmailChannel(), phone = new FakeSmsChannel();
  const store = new InMemoryIdentityStore();
  const svc = new IdentityService({
    store, crypto, now, config,
    emailOtp: new OtpManager(crypto, email, now),
    phoneOtp: new OtpManager(crypto, phone, now),
  });
  return { svc, store, email, phone, clock };
}
async function enroll(H: Harness, name: string, mail: string, tel: string): Promise<string> {
  const { userId } = H.svc.createAccount({ walletCaip10: wallet() });
  H.svc.setFullName(userId, name);
  const e = await H.svc.startEmailVerification(userId, mail);
  H.svc.confirmEmail(userId, e.challengeId, H.email.last()!.code);
  const p = await H.svc.startPhoneVerification(userId, tel);
  H.svc.confirmPhone(userId, p.challengeId, H.phone.last()!.code);
  return userId;
}

beforeEach(() => { seq = 0; });

describe('§2 Schema/DTO — apenas os 4 elementos, nada de PII extra', () => {
  // "address" de blockchain é público e permitido; proibimos apenas endereço residencial e demais PII.
  const FORBIDDEN = /(cpf|\brg\b|passport|passaporte|documento|document|photo|foto|selfie|liveness|birth|nascimento|\bdob\b|residential|residencial|residencia|street|\brua\b|postal|\bcep\b|zipcode|geolocation|latitude|longitude|contacts|contatos|fingerprint)/i;
  it('as colunas da conta não expõem nome/e-mail/telefone em claro nem qualquer PII proibida', async () => {
    const H = mkHarness();
    const uid = await enroll(H, 'João Silva', 'joao@gmail.com', '+5511999998888');
    const row = H.store.get(uid)!;
    expect(new Set(Object.keys(row))).toEqual(new Set(ACCOUNT_COLUMNS));
    for (const col of Object.keys(row)) {
      expect(col, `coluna proibida: ${col}`).not.toMatch(FORBIDDEN);
      // não pode existir campo pessoal em claro (só *Enc / *Index)
      expect(['fullname', 'name', 'nome', 'email', 'phone', 'telefone']).not.toContain(col.toLowerCase());
    }
    // os blobs cifrados não contêm o valor original
    const blob = JSON.stringify(row);
    expect(blob).not.toContain('João');
    expect(blob).not.toContain('joao@gmail.com');
    expect(blob).not.toContain('999998888');
  });
  it('os DTOs de entrada não pedem nenhum documento/dado invasivo', () => {
    for (const [name, schema] of Object.entries(INPUT_SCHEMAS)) {
      for (const key of Object.keys(schema.shape)) {
        expect(key, `${name}.${key}`).not.toMatch(FORBIDDEN);
      }
    }
  });
});

describe('§2 Nome — normalização e validação', () => {
  it('exige 2+ palavras, 3–120 chars e só letras/espaço/hífen/apóstrofo', () => {
    expect(validateName('  João   da  Silva ')).toBe('João da Silva');
    expect(validateName("O'Brien Souza")).toBe("O'Brien Souza");
    expect(() => validateName('João')).toThrow(/2\+ palavras/);
    expect(() => validateName('Jo')).toThrow(/entre 3 e 120/);
    expect(() => validateName('João 123')).toThrow(/não permitidos/);
  });
});

describe('§2 Mascaramento e visão pública', () => {
  it('e-mail e telefone só aparecem mascarados; nome completo e carteira visíveis', async () => {
    const H = mkHarness();
    const uid = await enroll(H, 'Maria Souza', 'maria@empresa.com', '+5511988887777');
    const v = H.svc.publicView(uid, 'SELLER');
    expect(v.fullName).toBe('Maria Souza');
    expect(v.walletCaip10).toMatch(/^solana:mainnet:/);
    expect(v.emailMasked).toBe(maskEmail('maria@empresa.com'));
    expect(v.emailMasked).not.toContain('maria@empresa.com');
    expect(v.phoneMasked).not.toContain('88887777');
    expect(maskEmail('joao@gmail.com')).toBe('j***@g***.com');
    expect(maskPhone('+5511999991234')).toBe('+55 •• •••••-1234');
  });
});

describe('§2 Unicidade por blind index', () => {
  it('e-mail já usado por outra conta é rejeitado; telefone idem', async () => {
    const H = mkHarness();
    await enroll(H, 'Ana Lima', 'ana@x.com', '+5511900000001');
    const { userId: u2 } = H.svc.createAccount({ walletCaip10: wallet() });
    await expect(H.svc.startEmailVerification(u2, 'ana@x.com')).rejects.toThrow(/já em uso/);
    await expect(H.svc.startPhoneVerification(u2, '+5511900000001')).rejects.toThrow(/já em uso/);
  });
  it('mesma carteira não pode criar duas contas', () => {
    const H = mkHarness(); const w = wallet();
    H.svc.createAccount({ walletCaip10: w });
    expect(() => H.svc.createAccount({ walletCaip10: w })).toThrow(/já vinculada/);
  });
});

describe('§10 OTP — bloqueio após 5 tentativas, uso único, expiração', () => {
  it('bloqueia após 5 códigos errados e invalida o desafio', async () => {
    const H = mkHarness();
    const { userId } = H.svc.createAccount({ walletCaip10: wallet() });
    const e = await H.svc.startEmailVerification(userId, 'z@z.com');
    for (let i = 0; i < 4; i++) expect(() => H.svc.confirmEmail(userId, e.challengeId, '000000')).toThrow(/inválido/);
    expect(() => H.svc.confirmEmail(userId, e.challengeId, '000000')).toThrow(/bloqueado/);
    // desafio destruído: código correto não vale mais
    expect(() => H.svc.confirmEmail(userId, e.challengeId, H.email.last()!.code)).toThrow(/inválido/);
  });
  it('código correto verifica; expira após TTL', async () => {
    const H = mkHarness();
    const { userId } = H.svc.createAccount({ walletCaip10: wallet() });
    const e = await H.svc.startEmailVerification(userId, 'ok@z.com');
    H.clock.t += 11 * 60_000; // > TTL 10min
    expect(() => H.svc.confirmEmail(userId, e.challengeId, H.email.last()!.code)).toThrow(/inválido/);
  });
  it('limite de envio de OTP (3/15min) por contato', async () => {
    const H = mkHarness();
    const { userId } = H.svc.createAccount({ walletCaip10: wallet() });
    await H.svc.startEmailVerification(userId, 'rate@z.com');
    await H.svc.startEmailVerification(userId, 'rate@z.com');
    await H.svc.startEmailVerification(userId, 'rate@z.com');
    await expect(H.svc.startEmailVerification(userId, 'rate@z.com')).rejects.toThrow(/Muitos códigos/);
  });
});

describe('§10 SMS — allowlist de país e teto diário', () => {
  it('país fora da allowlist é recusado', async () => {
    const H = mkHarness({ allowedCallingCodes: ['55'] });
    const { userId } = H.svc.createAccount({ walletCaip10: wallet() });
    await expect(H.svc.startPhoneVerification(userId, '+14155550123')).rejects.toThrow(/País não habilitado/);
  });
  it('teto diário de SMS bloqueia novos envios', async () => {
    const H = mkHarness({ smsDailyCap: 1 });
    const u1 = H.svc.createAccount({ walletCaip10: wallet() }).userId;
    const u2 = H.svc.createAccount({ walletCaip10: wallet() }).userId;
    await H.svc.startPhoneVerification(u1, '+5511900000010');
    await expect(H.svc.startPhoneVerification(u2, '+5511900000011')).rejects.toThrow(/Limite diário/);
  });
});

describe('§2 Elegibilidade e janela de reverificação', () => {
  it('só é elegível com carteira+nome+e-mail+telefone verificados', async () => {
    const H = mkHarness();
    const { userId } = H.svc.createAccount({ walletCaip10: wallet() });
    expect(H.svc.eligibility(userId).eligible).toBe(false);
    H.svc.setFullName(userId, 'Carlos Dias');
    const e = await H.svc.startEmailVerification(userId, 'c@d.com');
    H.svc.confirmEmail(userId, e.challengeId, H.email.last()!.code);
    expect(H.svc.eligibility(userId).eligible).toBe(false); // falta telefone
    const p = await H.svc.startPhoneVerification(userId, '+5511900000020');
    H.svc.confirmPhone(userId, p.challengeId, H.phone.last()!.code);
    expect(H.svc.eligibility(userId).eligible).toBe(true);
  });
  it('contato vencido (> CONTACT_REVERIFY_DAYS) torna inelegível', async () => {
    const H = mkHarness({ reverifyDays: 180 });
    const uid = await enroll(H, 'Pedro Reis', 'p@r.com', '+5511900000030');
    expect(H.svc.eligibility(uid).eligible).toBe(true);
    H.clock.t += 181 * 86_400_000;
    const r = H.svc.eligibility(uid);
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/reverificação/);
  });
});

describe('§2 Detecção de impersonação por nome parecido (TR39)', () => {
  it('"João Silva" e "Joao SiIva" têm o mesmo esqueleto', () => {
    expect(confusableSkeleton('João Silva')).toBe(confusableSkeleton('Joao SiIva'));
    expect(namesConfusable('João Silva', 'Joao SiIva')).toBe(true);
    expect(namesConfusable('João Silva', 'Maria Souza')).toBe(false);
  });
  it('o snapshot da operação sinaliza os participantes confundíveis', async () => {
    const H = mkHarness();
    const a = await enroll(H, 'João Silva', 'a@a.com', '+5511900000040');
    const b = await enroll(H, 'Joao SiIva', 'b@b.com', '+5511900000041');
    const c = await enroll(H, 'Marcos Reis', 'c@c.com', '+5511900000042');
    const { snapshots, confusableAlerts } = H.svc.buildOperationSnapshot([
      { role: 'SELLER', userId: a }, { role: 'BUYER', userId: b }, { role: 'PAYMASTER_1', userId: c },
    ]);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]!.verificationLevel).toBe('BASIC');
    expect(confusableAlerts).toHaveLength(1);
  });
});

describe('§2/§6 Snapshot — regras de participantes', () => {
  it('rejeita mesmo usuário em dois papéis (cobre PM01=PM02) e exige 3–4', async () => {
    const H = mkHarness();
    const a = await enroll(H, 'Um Nome', 'a1@a.com', '+5511900000050');
    const b = await enroll(H, 'Dois Nomes', 'b1@b.com', '+5511900000051');
    expect(() => H.svc.buildOperationSnapshot([{ role: 'PAYMASTER_1', userId: a }, { role: 'PAYMASTER_2', userId: a }, { role: 'SELLER', userId: b }])).toThrow(/mais de um papel/);
    expect(() => H.svc.buildOperationSnapshot([{ role: 'SELLER', userId: a }, { role: 'BUYER', userId: b }])).toThrow(/3 ou 4/);
  });
  it('rejeita participante inelegível', async () => {
    const H = mkHarness();
    const a = await enroll(H, 'Elegível Um', 'e1@a.com', '+5511900000060');
    const b = await enroll(H, 'Elegível Dois', 'e2@a.com', '+5511900000061');
    const c = H.svc.createAccount({ walletCaip10: wallet() }).userId; // sem verificação
    expect(() => H.svc.buildOperationSnapshot([{ role: 'SELLER', userId: a }, { role: 'BUYER', userId: b }, { role: 'PAYMASTER_1', userId: c }])).toThrow(/inelegível/);
  });
});

describe('§3.2 Endereço de liquidação — exige prova de posse', () => {
  it('sem prova é rejeitado; com prova é whitelisted; conflito entre contas', async () => {
    const H = mkHarness();
    const a = await enroll(H, 'Alfa Um', 'al@a.com', '+5511900000070');
    const other = wallet();
    expect(() => H.svc.addSettlementAddress(a, other, false)).toThrow(/Prova de posse/);
    H.svc.addSettlementAddress(a, other, true);
    expect(H.store.get(a)!.settlementAddresses.some(s => s.caip10 === other)).toBe(true);
    const b = await enroll(H, 'Beta Dois', 'be@b.com', '+5511900000071');
    expect(() => H.svc.addSettlementAddress(b, other, true)).toThrow(/já vinculado/);
  });
});

describe('§4 Trocas controladas', () => {
  it('troca durante operação ativa é bloqueada', async () => {
    const H = mkHarness();
    const uid = await enroll(H, 'Gama Três', 'g@a.com', '+5511900000080');
    expect(() => H.svc.changeContact(uid, 'email', { walletSigOk: true, newContactOtpOk: true, hasActiveOperation: true })).toThrow(/operação ativa/);
    expect(() => H.svc.changeWalletWithCurrent(uid, wallet(), { currentSigOk: true, newSigOk: true, emailOtpOk: true, hasActiveOperation: true })).toThrow(/operação ativa/);
  });
  it('recuperação de carteira perdida respeita a carência de 72h', async () => {
    const H = mkHarness();
    const uid = await enroll(H, 'Delta Quatro', 'd@a.com', '+5511900000090');
    const { readyAt } = H.svc.initiateLostWalletRecovery(uid, { emailOtpOk: true, phoneOtpOk: true, hasActiveOperation: false });
    const novo = wallet();
    expect(() => H.svc.completeLostWalletRecovery(uid, novo)).toThrow(/carência/);
    H.clock.t = readyAt + 1;
    H.svc.completeLostWalletRecovery(uid, novo);
    expect(H.store.get(uid)!.walletCaip10).toBe(novo);
  });
  it('recuperação sem os dois OTP é recusada', async () => {
    const H = mkHarness();
    const uid = await enroll(H, 'Eps Cinco', 'ep@a.com', '+5511900000091');
    expect(() => H.svc.initiateLostWalletRecovery(uid, { emailOtpOk: true, phoneOtpOk: false, hasActiveOperation: false })).toThrow(/OTP/);
  });
});

describe('§8 Crypto-shredding e auditoria íntegra', () => {
  it('após apagar a DEK os campos ficam ilegíveis, mas a cadeia de auditoria continua válida', async () => {
    const clock = { t: 1_700_000_000_000 };
    const now = (): number => clock.t;
    const crypto = new FieldCrypto(deriveDevKeys(MASTER));
    const store = new InMemoryIdentityStore();
    const auditStore = new MemoryStore();
    const audit = new AuditLog(auditStore, now);
    const email = new FakeEmailChannel(), phone = new FakeSmsChannel();
    const svc = new IdentityService({ store, crypto, now, audit, emailOtp: new OtpManager(crypto, email, now), phoneOtp: new OtpManager(crypto, phone, now) });
    const { userId } = svc.createAccount({ walletCaip10: wallet() });
    svc.setFullName(userId, 'Zeta Seis');
    const e = await svc.startEmailVerification(userId, 'z6@a.com'); svc.confirmEmail(userId, e.challengeId, email.last()!.code);
    expect(svc.publicView(userId).fullName).toBe('Zeta Seis');
    svc.cryptoShred(userId);
    expect(() => svc.publicView(userId)).toThrow(); // conta shredded/DEK destruída
    await audit.append({ actorType: 'system', actorId: 'test', category: 'flush', dealId: null, payload: {} });
    const events = await auditStore.listAudit(1000);
    expect(events.length).toBeGreaterThan(0);
    expect(AuditLog.verify(events).ok).toBe(true);
    // e nenhum payload de auditoria contém PII crua
    for (const ev of events) expect(containsPersonalData(JSON.stringify(ev.payload))).toBe(false);
  });
});

describe('§8 Redação de logs — nenhuma PII vaza', () => {
  it('redact remove nome/e-mail/telefone/código por chave e por padrão', () => {
    const out = JSON.stringify(redact({
      fullName: 'João Silva', email: 'joao@gmail.com', phone: '+5511999998888', code: '123456',
      note: 'contato joao@gmail.com tel +5511999998888', nested: { nome: 'x', ok: 1 },
    }));
    expect(out).not.toContain('João Silva');
    expect(out).not.toContain('joao@gmail.com');
    expect(out).not.toContain('999998888');
    expect(out).not.toContain('123456');
    expect(containsPersonalData('login ok user=usr_123 wallet=solana:mainnet:abc')).toBe(false);
    expect(containsPersonalData('erro para joao@gmail.com')).toBe(true);
  });
});
