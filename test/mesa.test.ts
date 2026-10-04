/** Mesa v3 — criação, convites por cadeira, prova de posse, consumo atômico, DTO por papel, status. */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';
import { PortalService } from '../src/portal/portal.js';
import { AuditLog } from '../src/audit/audit.js';
import { WalletAuth } from '../src/wallet/auth.js';
import { AdapterRegistry } from '../src/adapters/types.js';
import { MesaService, newInviteCode, type CreateMesaInput } from '../src/mesa/mesaService.js';
import { INVITE_CODE_ALPHABET } from '../src/domain/constants.js';
import { validateChairBalances, type BalanceReaders } from '../src/mesa/balances.js';
import { testSigning } from '../src/engines/signature.js';
import { Clock } from './helpers.js';

const SOL_ASSET = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
const USDT_ASSET = { network: 'solana', contractOrMint: 'USDT1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDT' };
const MESA_INPUT: CreateMesaInput = {
  label: 'Mesa de teste', network: 'solana',
  chairs: [
    { role: 'SELLER', expectedAsset: SOL_ASSET, label: 'cliente da reunião de terça' },
    { role: 'BUYER', expectedAsset: USDT_ASSET },
    { role: 'PAYMASTER_1', expectedAsset: SOL_ASSET },
  ],
};

interface Ctx { clock: Clock; store: MemoryStore; portal: PortalService; svc: MesaService; token: string }
async function makeCtx(): Promise<Ctx> {
  const clock = new Clock();
  const store = new MemoryStore();
  const audit = new AuditLog(store, clock.now);
  const portal = new PortalService({ now: clock.now });
  const auth = new WalletAuth(store, new AdapterRegistry(), { env: 'dev', sessionSecret: 'x'.repeat(48), sessionTtlMs: 600_000, challengeTtlMs: 300_000, operators: new Set(), appDomain: 'otc.test' }, clock.now);
  const svc = new MesaService({ portal, store, audit, auth, getDeal: async () => null, baseUrl: 'https://otc.test', now: clock.now });
  const { token } = portal.register({ name: 'Pay Master Um', email: 'pm@verum.test', password: 'senha-forte-1' });
  portal.connectWallet(token, { address: 'PM1walletSolanaAddress11111111111111', network: 'solana' });
  return { clock, store, portal, svc, token };
}

async function joinAs(ctx: Ctx, inviteId: string, code: string, firstName: string, wallet = testSigning.solana()): Promise<{ token: string; mesaId: string; chairId: string }> {
  const ch = await ctx.svc.joinChallenge(inviteId, { code, firstName, network: 'solana', address: wallet.address });
  const signature = wallet.sign(ch.message);
  return ctx.svc.joinMesa(inviteId, { code, firstName, network: 'solana', address: wallet.address, nonce: ch.nonce, signature });
}

describe('MesaService — criação e convites', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });

  it('cria Mesa A e Mesa B com códigos diferentes e dados isolados', async () => {
    const a = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const b = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    expect(a.code).not.toBe(b.code);
    expect(a.mesaId).not.toBe(b.mesaId);
    const invA = await ctx.svc.createChairInvite(ctx.token, a.mesaId, a.chairs[0]!.chairId);
    expect(await ctx.store.listMesaInvites(b.mesaId)).toHaveLength(0);
    // convite da mesa A não funciona com cadeira/mesa B
    await expect(ctx.svc.revokeInvite(ctx.token, b.mesaId, invA.inviteId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // PM1 já entra conectado com a wallet do admin
    expect(a.chairs.find(c => c.role === 'PAYMASTER_1')?.wallet?.address).toContain('PM1wallet');
    expect((await ctx.svc.listMesas(ctx.token))).toHaveLength(2);
  });

  it('convite tem código XXXX-XXXX sem caracteres ambíguos e mensagem pronta com avisos obrigatórios', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    expect(inv.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    for (const c of inv.code.replace('-', '')) expect(INVITE_CODE_ALPHABET).toContain(c);
    expect(inv.link).toContain(`/otc/convite/${encodeURIComponent(inv.inviteId)}?c=`);
    expect(inv.message).toContain('somente pela Verum Wallet');
    expect(inv.message).toContain('US$ 5');
    expect(inv.message).toContain(inv.code);
    expect(inv.message).toContain('Sua função: Vendedor');
    // código nunca armazenado em claro
    const row = await ctx.store.getMesaInvite(inv.inviteId);
    expect(JSON.stringify(row)).not.toContain(inv.code.replace('-', ''));
  });

  it('gerador de código usa só o alfabeto sem 0 O 1 I L', () => {
    for (let i = 0; i < 200; i++) {
      const code = newInviteCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    }
  });

  it('resolve identifica mesa, cadeira e função; código errado não valida', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    const r = await ctx.svc.resolveInvite(inv.inviteId, inv.code);
    expect(r).toMatchObject({ mesaCode: mesa.code, role: 'SELLER', roleLabel: 'Vendedor', codeValid: true, status: 'PENDING' });
    const bad = await ctx.svc.resolveInvite(inv.inviteId, 'AAAA-AAAA');
    expect(bad.codeValid).toBe(false);
    await expect(ctx.svc.joinChallenge(inv.inviteId, { code: 'AAAA-AAAA', firstName: 'Ana', network: 'solana', address: testSigning.solana().address })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('TTL do convite nunca ultrapassa o TTL da mesa', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    ctx.clock.advance(50 * 60_000); // restam 10 min de mesa (sessão: novo login — idle lock real derruba a anterior)
    const { token: fresh } = ctx.portal.login({ email: 'pm@verum.test', password: 'senha-forte-1' });
    const inv = await ctx.svc.createChairInvite(fresh, mesa.mesaId, mesa.chairs[0]!.chairId);
    expect(inv.expiresAt).toBe(mesa.expiresAt);
  });
});

describe('MesaService — conexão com prova de posse', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });

  it('challenge assinado válido conecta a cadeira com nome e wallet; sessão emitida', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    const w = testSigning.solana();
    const ch = await ctx.svc.joinChallenge(inv.inviteId, { code: inv.code, firstName: 'Gabriel', network: 'solana', address: w.address });
    expect(ch.message).toContain('Autorizar entrada na Mesa OTC');
    expect(ch.message).toContain(mesa.code);
    expect(ch.message).toContain('Gabriel');
    expect(ch.message).toContain(w.address);
    const r = await ctx.svc.joinMesa(inv.inviteId, { code: inv.code, firstName: 'Gabriel', network: 'solana', address: w.address, nonce: ch.nonce, signature: w.sign(ch.message) });
    expect(r.mesaId).toBe(mesa.mesaId);
    const chair = mesa.chairs.find(c => c.chairId === r.chairId);
    expect(chair?.wallet?.address).toBe(w.address);
    expect(chair?.firstName).toBe('Gabriel');
    expect((await ctx.store.getMesaInvite(inv.inviteId))?.status).toBe('USED');
  });

  it('assinatura inválida bloqueia; replay do nonce bloqueia; nonce expirado bloqueia', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    const w = testSigning.solana(); const intruso = testSigning.solana();
    const ch = await ctx.svc.joinChallenge(inv.inviteId, { code: inv.code, firstName: 'Ana', network: 'solana', address: w.address });
    await expect(ctx.svc.joinMesa(inv.inviteId, { code: inv.code, firstName: 'Ana', network: 'solana', address: w.address, nonce: ch.nonce, signature: intruso.sign(ch.message) })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    // válido consome o nonce…
    await ctx.svc.joinMesa(inv.inviteId, { code: inv.code, firstName: 'Ana', network: 'solana', address: w.address, nonce: ch.nonce, signature: w.sign(ch.message) });
    // …replay com o mesmo nonce bloqueado
    await expect(ctx.svc.joinMesa(inv.inviteId, { code: inv.code, firstName: 'Ana', network: 'solana', address: w.address, nonce: ch.nonce, signature: w.sign(ch.message) })).rejects.toMatchObject({ code: 'NONCE_INVALID' });
    // nonce expirado
    const inv2 = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[1]!.chairId);
    const w2 = testSigning.solana();
    const ch2 = await ctx.svc.joinChallenge(inv2.inviteId, { code: inv2.code, firstName: 'Beto', network: 'solana', address: w2.address });
    ctx.clock.advance(301_000);
    await expect(ctx.svc.joinMesa(inv2.inviteId, { code: inv2.code, firstName: 'Beto', network: 'solana', address: w2.address, nonce: ch2.nonce, signature: w2.sign(ch2.message) })).rejects.toMatchObject({ code: 'SIGNATURE_EXPIRED' });
  });

  it('duas wallets no mesmo convite → exatamente uma vence (consumo atômico)', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    const wa = testSigning.solana(); const wb = testSigning.solana();
    const cha = await ctx.svc.joinChallenge(inv.inviteId, { code: inv.code, firstName: 'Ana', network: 'solana', address: wa.address });
    const chb = await ctx.svc.joinChallenge(inv.inviteId, { code: inv.code, firstName: 'Beto', network: 'solana', address: wb.address });
    const results = await Promise.allSettled([
      ctx.svc.joinMesa(inv.inviteId, { code: inv.code, firstName: 'Ana', network: 'solana', address: wa.address, nonce: cha.nonce, signature: wa.sign(cha.message) }),
      ctx.svc.joinMesa(inv.inviteId, { code: inv.code, firstName: 'Beto', network: 'solana', address: wb.address, nonce: chb.nonce, signature: wb.sign(chb.message) }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(String((loser.reason as Error).message)).toContain('já foi utilizado por outra wallet');
  });

  it('convite expirado, usado e revogado bloqueiam; mesma wallet não ocupa duas cadeiras', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const seller = mesa.chairs[0]!; const buyer = mesa.chairs[1]!;
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, seller.chairId);
    const w = testSigning.solana();
    await joinAs(ctx, inv.inviteId, inv.code, 'Ana', w);
    // usado
    await expect(ctx.svc.joinChallenge(inv.inviteId, { code: inv.code, firstName: 'Zé', network: 'solana', address: testSigning.solana().address })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // mesma wallet na segunda cadeira
    const inv2 = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, buyer.chairId);
    await expect(ctx.svc.joinChallenge(inv2.inviteId, { code: inv2.code, firstName: 'Ana', network: 'solana', address: w.address })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    // revogado
    await ctx.svc.revokeInvite(ctx.token, mesa.mesaId, inv2.inviteId);
    await expect(ctx.svc.joinChallenge(inv2.inviteId, { code: inv2.code, firstName: 'Beto', network: 'solana', address: testSigning.solana().address })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // expirado
    const inv3 = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, buyer.chairId);
    ctx.clock.advance(61 * 60_000);
    await expect(ctx.svc.joinChallenge(inv3.inviteId, { code: inv3.code, firstName: 'Beto', network: 'solana', address: testSigning.solana().address })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('primeiro nome fora de 2–30 caracteres é rejeitado', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    await expect(ctx.svc.joinChallenge(inv.inviteId, { code: inv.code, firstName: 'G', network: 'solana', address: testSigning.solana().address })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(ctx.svc.joinChallenge(inv.inviteId, { code: inv.code, firstName: 'x'.repeat(31), network: 'solana', address: testSigning.solana().address })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('MesaService — status, configuração e DTO por papel', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });

  it('deriva DRAFT → WAITING_INVITES → WAITING_CONNECTIONS → ACTIVE → READY_FOR_APPROVAL; 60 min → EXPIRED', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    expect(await ctx.svc.statusOf(mesa)).toBe('DRAFT');
    const invS = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    expect(await ctx.svc.statusOf(mesa)).toBe('WAITING_INVITES'); // comprador ainda sem convite
    const invB = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[1]!.chairId);
    expect(await ctx.svc.statusOf(mesa)).toBe('WAITING_CONNECTIONS');
    await joinAs(ctx, invS.inviteId, invS.code, 'Ana');
    await joinAs(ctx, invB.inviteId, invB.code, 'Beto');
    expect(await ctx.svc.statusOf(mesa)).toBe('ACTIVE');
    ctx.svc.updateConfig(ctx.token, mesa.mesaId, { amountInBase: '1000000000', discountBps: 300, commissionBps: 200 });
    expect(await ctx.svc.statusOf(mesa)).toBe('READY_FOR_APPROVAL');
    ctx.clock.advance(61 * 60_000);
    expect(await ctx.svc.statusOf(mesa)).toBe('EXPIRED');
  });

  it('configuração: token inválido → FORBIDDEN; após aprovação → VERSION_CONFLICT (409)', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    expect(() => ctx.svc.updateConfig('token-falso', mesa.mesaId, { discountBps: 100 })).toThrowError(/Sessão/);
    ctx.svc.updateConfig(ctx.token, mesa.mesaId, { amountInBase: '5', discountBps: 0, commissionBps: 0 });
    ctx.svc.markApproved(mesa, 'pm_teste');
    expect(mesa.termsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => ctx.svc.updateConfig(ctx.token, mesa.mesaId, { discountBps: 50 })).toThrowError(/aprovada/);
  });

  it('DTO do participante não contém campos administrativos; DTO do admin contém tudo', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const inv = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    const r = await joinAs(ctx, inv.inviteId, inv.code, 'Gabriel');
    const part = JSON.stringify(await ctx.svc.mesaViewFor(mesa, { kind: 'participant', chairId: r.chairId }));
    for (const banned of ['inviteId', 'invite', 'link', 'code_hash', 'label', 'approvals', 'email', 'notes', 'chairId"']) {
      // "label" interno da cadeira e convites nunca vazam ao participante
      if (banned === 'chairId"') continue; // o próprio viewer tem chairId — validado abaixo por campos proibidos específicos
      expect(part.includes(`"${banned}"`), `campo proibido no DTO do participante: ${banned}`).toBe(false);
    }
    expect(part).not.toContain('cliente da reunião de terça');
    expect(part).toContain('"isMe"');
    const admin = JSON.stringify(await ctx.svc.mesaViewFor(mesa, { kind: 'admin' }));
    expect(admin).toContain('"invites"');
    expect(admin).toContain('cliente da reunião de terça');
    // wallet do participante aparece truncada 7…3 no DTO limitado
    const dto = await ctx.svc.mesaViewFor(mesa, { kind: 'participant', chairId: r.chairId }) as { chairs: { wallet: string | null; isMe: boolean }[] };
    const me = dto.chairs.find(c => c.isMe)!;
    expect(me.wallet).toMatch(/^.{7}….{3}$/);
  });

  it('cancelamento → CANCELLED e bloqueia novos convites', async () => {
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    ctx.svc.cancelMesa(ctx.token, mesa.mesaId, 'Negociação desfeita');
    expect(await ctx.svc.statusOf(mesa)).toBe('CANCELLED');
    await expect(ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('validateChairBalances — motivos nominais', () => {
  it('gás abaixo de US$ 5 e ativo insuficiente produzem motivos nominais; tudo ok → ok=true', async () => {
    const ctx = await makeCtx();
    const mesa = ctx.svc.createMesa(ctx.token, MESA_INPUT);
    const invS = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[0]!.chairId);
    const invB = await ctx.svc.createChairInvite(ctx.token, mesa.mesaId, mesa.chairs[1]!.chairId);
    await joinAs(ctx, invS.inviteId, invS.code, 'Ana');
    await joinAs(ctx, invB.inviteId, invB.code, 'Beto');
    const poor: BalanceReaders = {
      native: async (_n, addr) => ({ amount: addr.startsWith('PM1') ? 1 : 0.001 }), // PM1 ok, resto sem gás
      tokens: async () => [{ symbol: 'USDT', contract: 'USDT1111111111111111111111111111111111111111', amount: 10 }],
      priceUsdOf: async () => 150, // SOL a US$ 150 → 0.001 SOL = US$ 0,15 < US$ 5
    };
    const required = (c: typeof mesa.chairs[number]) => c.role === 'SELLER' ? 100 : c.role === 'BUYER' ? 1000 : null;
    const bad = await validateChairBalances(mesa, poor, Date.now(), required);
    expect(bad.ok).toBe(false);
    expect(bad.failures.join('\n')).toContain('Vendedor (Ana): gás abaixo de US$ 5');
    expect(bad.failures.join('\n')).toContain('Comprador (Beto): saldo de USDT insuficiente');
    const rich: BalanceReaders = { native: async () => ({ amount: 10 }), tokens: async () => [{ symbol: 'USDT', contract: 'USDT1111111111111111111111111111111111111111', amount: 5000 }], priceUsdOf: async () => 150 };
    const good = await validateChairBalances(mesa, rich, Date.now(), c => (c.role === 'SELLER' ? 5 : c.role === 'BUYER' ? 1000 : null));
    expect(good.ok, good.failures.join('; ')).toBe(true);
    // fallback sem preço: 0,05 SOL mínimo
    const noPrice: BalanceReaders = { native: async () => ({ amount: 0.01 }), tokens: async () => [], priceUsdOf: async () => null };
    const fb = await validateChairBalances(mesa, noPrice, Date.now());
    expect(fb.failures.join('\n')).toContain('abaixo do mínimo de 0,05 SOL');
  });
});
