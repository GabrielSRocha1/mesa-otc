/**
 * Testes de segurança de salas e convives (VERUM OTC §5) — determinísticos, sobre o RoomService.
 * verifySignature é injetado como stub (o teste de assinatura real via rede está em rooms.api.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { deriveDevKeys, FieldCrypto } from '../src/identity/crypto.js';
import { OtpManager, FakeEmailChannel, FakeSmsChannel } from '../src/identity/otp.js';
import { InMemoryIdentityStore } from '../src/identity/store.js';
import { IdentityService } from '../src/identity/service.js';
import { RoomService, type RoomActor } from '../src/rooms/service.js';

const MASTER = 'b'.repeat(64);
let seq = 0;
const wallet = (): string => `solana:mainnet:So1RoomW${String.fromCharCode(97 + (++seq % 26))}${seq.toString(36)}xyzKp`;

function mk() {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const crypto = new FieldCrypto(deriveDevKeys(MASTER));
  const email = new FakeEmailChannel(), phone = new FakeSmsChannel();
  const identity = new IdentityService({ store: new InMemoryIdentityStore(), crypto, now, emailOtp: new OtpManager(crypto, email, now), phoneOtp: new OtpManager(crypto, phone, now) });
  const rooms = new RoomService({ identity, now, verifySignature: (_n, _m, s) => s === 'VALID', config: { allowedOrigins: ['https://otc.verumcrypto.com'] } });
  let e = 0, p = 0;
  const enroll = async (name: string): Promise<RoomActor> => {
    const { userId } = identity.createAccount({ walletCaip10: wallet() });
    identity.setFullName(userId, name);
    const em = `u${++e}@x.com`, tel = `+55119000${String(++p).padStart(5, '0')}`;
    const ev = await identity.startEmailVerification(userId, em); identity.confirmEmail(userId, ev.challengeId, email.last()!.code);
    const pv = await identity.startPhoneVerification(userId, tel); identity.confirmPhone(userId, pv.challengeId, phone.last()!.code);
    return { userId, network: 'solana', address: 'addr_' + userId, contact: { email: em, phone: tel } } as RoomActor & { contact: { email: string; phone: string } };
  };
  return { clock, now, identity, rooms, enroll };
}
const contactOf = (a: RoomActor): { email: string } => (a as RoomActor & { contact: { email: string } }).contact;

describe('§5.1 Criação e convite', () => {
  it('só PM01 elegível cria; anti-enumeração: convidar responde idêntico exista ou não a conta', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const seller = await H.enroll('Sergio Vendedor');
    const roomV = H.rooms.createRoom(pm1); expect(roomV.status).toBe('OPEN'); expect(roomV.members).toHaveLength(1);
    // conta existente
    const r1 = H.rooms.invite(roomV.id, pm1, { role: 'SELLER', email: contactOf(seller).email });
    // conta inexistente
    const r2 = H.rooms.invite(roomV.id, pm1, { role: 'BUYER', email: 'ninguem@nao-existe.com' });
    expect(Object.keys(r1).sort()).toEqual(Object.keys(r2).sort()); // forma idêntica
    expect(r1.token).toMatch(/^[A-Za-z0-9_-]{40,}$/); expect(r2.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(r1.token).not.toBe(r2.token);
  });
  it('PM01 não convida a si mesmo (cobre PM01 ≠ PM02)', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const room = H.rooms.createRoom(pm1);
    expect(() => H.rooms.invite(room.id, pm1, { role: 'PAYMASTER_2', email: contactOf(pm1).email })).toThrow(/si mesmo/);
  });
});

describe('§5.2 Token de convite', () => {
  async function setup() {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const seller = await H.enroll('Sergio Vendedor');
    const room = H.rooms.createRoom(pm1);
    const inv = H.rooms.invite(room.id, pm1, { role: 'SELLER', email: contactOf(seller).email });
    return { H, pm1, seller, room, inv };
  }
  it('aceite consome o token; reuso é rejeitado', async () => {
    const { H, seller, inv } = await setup();
    const ch = H.rooms.resolveInvite(inv.token, seller);
    const v = await H.rooms.acceptInvite(inv.token, ch.nonce, 'VALID', seller);
    expect(v.members.some(m => m.role === 'SELLER')).toBe(true);
    expect(() => H.rooms.resolveInvite(inv.token, seller)).toThrow(/inválido|expirado/); // token consumido
  });
  it('token expirado (> TTL) é rejeitado', async () => {
    const { H, seller, inv } = await setup();
    H.clock.t += 31 * 60_000;
    expect(() => H.rooms.resolveInvite(inv.token, seller)).toThrow(/inválido|expirado/);
  });
  it('token usado por OUTRO usuário é rejeitado (uniforme)', async () => {
    const { H, inv } = await setup(); const intruso = await H.enroll('Intruso Qualquer');
    expect(() => H.rooms.resolveInvite(inv.token, intruso)).toThrow(/inválido|expirado/);
  });
  it('assinatura de ingresso inválida (carteira não prova posse) é rejeitada', async () => {
    const { H, seller, inv } = await setup();
    const ch = H.rooms.resolveInvite(inv.token, seller);
    await expect(H.rooms.acceptInvite(inv.token, ch.nonce, 'ASSINATURA-RUIM', seller)).rejects.toThrow(/Assinatura/);
  });
});

describe('§5 Regras de participação', () => {
  it('mesma pessoa em dois papéis é rejeitada', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const seller = await H.enroll('Sergio V');
    const room = H.rooms.createRoom(pm1);
    const i1 = H.rooms.invite(room.id, pm1, { role: 'SELLER', email: contactOf(seller).email });
    const c1 = H.rooms.resolveInvite(i1.token, seller); await H.rooms.acceptInvite(i1.token, c1.nonce, 'VALID', seller);
    const i2 = H.rooms.invite(room.id, pm1, { role: 'BUYER', email: contactOf(seller).email });
    const c2 = H.rooms.resolveInvite(i2.token, seller);
    await expect(H.rooms.acceptInvite(i2.token, c2.nonce, 'VALID', seller)).rejects.toThrow(/já participa/);
  });
  it('sala completa (PM01+Vendedor+Comprador) vira FILLED com snapshot', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const s = await H.enroll('Sergio V'); const b = await H.enroll('Bruno C');
    const room = H.rooms.createRoom(pm1);
    for (const [role, u] of [['SELLER', s], ['BUYER', b]] as const) {
      const i = H.rooms.invite(room.id, pm1, { role, email: contactOf(u).email });
      const c = H.rooms.resolveInvite(i.token, u); await H.rooms.acceptInvite(i.token, c.nonce, 'VALID', u);
    }
    const v = H.rooms.getView(room.id, pm1.userId);
    expect(v.status).toBe('FILLED'); expect(v.members).toHaveLength(3);
  });
});

describe('§5.4 WebSocket — ticket, Origin, autorização por sala', () => {
  it('ticket de uso único: consumo repetido é rejeitado; Origin inválida barrada', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const room = H.rooms.createRoom(pm1);
    const t = H.rooms.issueWsTicket(room.id, pm1);
    expect(H.rooms.consumeWsTicket(t.ticket)).toMatchObject({ roomId: room.id, userId: pm1.userId });
    expect(() => H.rooms.consumeWsTicket(t.ticket)).toThrow(/inválido|expirado/); // reuso
    expect(() => H.rooms.consumeWsTicket('inexistente')).toThrow(/inválido|expirado/);
    expect(H.rooms.validateOrigin('https://otc.verumcrypto.com')).toBe(true);
    expect(H.rooms.validateOrigin('https://evil.example')).toBe(false);
    expect(H.rooms.validateOrigin(undefined)).toBe(false);
  });
  it('ticket expirado (> 30s) é rejeitado', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const room = H.rooms.createRoom(pm1);
    const t = H.rooms.issueWsTicket(room.id, pm1); H.clock.t += 31_000;
    expect(() => H.rooms.consumeWsTicket(t.ticket)).toThrow(/inválido|expirado/);
  });
});

describe('§5.5 Encerramento irreversível', () => {
  it('encerrar revoga convites pendentes, barra mensagens e bloqueia novos tickets', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const seller = await H.enroll('Sergio V');
    const room = H.rooms.createRoom(pm1);
    const inv = H.rooms.invite(room.id, pm1, { role: 'SELLER', email: contactOf(seller).email });
    const closed = H.rooms.close(room.id, pm1, 'SETTLED');
    expect(closed.status).toBe('CLOSED');
    expect(closed.invitations.every(i => i.status !== 'pending')).toBe(true);
    expect(() => H.rooms.resolveInvite(inv.token, seller)).toThrow(/inválido|expirado/); // convite revogado
    expect(() => H.rooms.authorizeRoomMessage(room.id, pm1.userId)).toThrow(/encerrada/); // mensagem barrada
    expect(() => H.rooms.issueWsTicket(room.id, pm1)).toThrow(/encerrada/);
  });
});

describe('§5.3 Impressão digital da operação', () => {
  it('6 palavras determinísticas do termsHash; muda com os termos', async () => {
    const H = mk(); const pm1 = await H.enroll('Paula Um'); const room = H.rooms.createRoom(pm1);
    const hash1 = 'a'.repeat(64); const v1 = H.rooms.setTerms(room.id, pm1, { version: 1, termsHash: hash1 });
    expect(v1.terms!.fingerprint).toHaveLength(6);
    const v1b = H.rooms.getView(room.id, pm1.userId); expect(v1b.terms!.fingerprint).toEqual(v1.terms!.fingerprint); // determinístico
    const v2 = H.rooms.setTerms(room.id, pm1, { version: 2, termsHash: 'f'.repeat(64) });
    expect(v2.terms!.fingerprint).not.toEqual(v1.terms!.fingerprint); // muda com os termos
  });
});
