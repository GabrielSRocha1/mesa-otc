/**
 * Ordem de assinatura por carteira (o pedido do usuário): após o approve, CADA carteira conectada
 * só é chamada/aceita a assinar NA SUA VEZ — Vendedor → Pay Master 1 → Pay Master 2 → Comprador.
 * Prova, a cada passo: (a) turnRole é o papel certo; (b) a carteira do papel seguinte é RECUSADA
 * (OUT_OF_ORDER) antes da vez; (c) a carteira da vez recebe o envelope, assina e avança a esteira.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, type Wallet } from './helpers.js';
import type { App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';

const SOL = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
const USDC = { network: 'solana', contractOrMint: 'USDC1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC' };
const readers: BalanceReaders = { native: async () => ({ amount: 1000 }), tokens: async () => [{ symbol: 'USDC', contract: USDC.contractOrMint, amount: 10 ** 9 }], priceUsdOf: async () => 150 };
const H = (t: string) => ({ authorization: `Bearer ${t}` });
let seq = 0; const idem = () => `sign-order-${Date.now()}-${seq++}`;
const email = () => `so-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;

async function walletLogin(app: App, w: Wallet): Promise<string> {
  const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=${w.network}&address=${w.address}` })).json<{ message: string; nonce: string }>();
  const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
  const v = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: w.network, address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } });
  expect(v.statusCode).toBe(200);
  return v.json<{ token: string }>().token;
}
async function join(app: App, pm: string, mesaId: string, chairId: string, firstName: string, w: Wallet): Promise<string> {
  const inv = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${chairId}/invite`, headers: H(pm) });
  const { inviteId, code } = inv.json<{ inviteId: string; code: string }>();
  const ch = await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inviteId)}/challenge`, payload: { code, firstName, network: 'solana', address: w.address } });
  const { message, nonce } = ch.json<{ message: string; nonce: string }>();
  const j = await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${encodeURIComponent(inviteId)}/join`, payload: { code, firstName, network: 'solana', address: w.address, nonce, signature: await w.signMessage(message) } });
  expect(j.statusCode).toBe(201);
  return j.json<{ token: string }>().token; // token de PARTICIPANTE (sessão da mesa)
}
/** Faz a carteira `w` assinar o papel `role` via o MESMO caminho da UI: pega o envelope e posta. */
async function signTurn(app: App, dealId: string, role: string, w: Wallet) {
  const tok = await walletLogin(app, w);
  const env = (await app.api.inject({ method: 'GET', url: `/v1/deals/${dealId}/approval-envelope`, headers: H(tok) })).json<{ message: string; payload: { nonce: string } }>();
  return app.api.inject({ method: 'POST', url: `/v1/deals/${dealId}/approvals`, headers: { ...H(tok), 'idempotency-key': idem() }, payload: { role, signature: await w.signMessage(env.message), nonce: env.payload.nonce } });
}
const turnOf = async (app: App, mesaId: string, ptok: string) =>
  (await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaId}`, headers: H(ptok) })).json<{ status: string; deal: { turnRole: string | null; validSignatures: number; requiredSignatures: number } }>();

describe('Mesa · assinaturas chamadas por carteira NA ORDEM (Vendedor→PM1→PM2→Comprador)', () => {
  it('cada carteira só assina na vez; fora da vez é recusada; ao fim liquida', async () => {
    const { app } = await makeApp({ balanceReaders: readers });

    // PM registra e conecta a carteira do admin → vira a cadeira PAYMASTER_1
    const reg = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM Ordem', email: email(), password: 'senha-forte-1' } });
    const pm = reg.json<{ token: string }>().token;
    const pm1 = solWallet(); // carteira do admin = cadeira PM1
    expect((await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: H(pm), payload: { address: pm1.address, network: 'solana' } })).statusCode).toBe(200);

    // mesa de 4 cadeiras
    const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: H(pm), payload: { network: 'solana', chairs: [
      { role: 'SELLER', expectedAsset: SOL }, { role: 'BUYER', expectedAsset: USDC },
      { role: 'PAYMASTER_1', expectedAsset: SOL }, { role: 'PAYMASTER_2', expectedAsset: SOL },
    ] } })).json<{ mesaId: string; chairs: { chairId: string; role: string }[] }>();
    const chair = (r: string) => mesa.chairs.find(c => c.role === r)!.chairId;

    const seller = solWallet(), buyer = solWallet(), pm2 = solWallet();
    const sellerPtok = await join(app, pm, mesa.mesaId, chair('SELLER'), 'Vendedor', seller);
    await join(app, pm, mesa.mesaId, chair('BUYER'), 'Comprador', buyer);
    await join(app, pm, mesa.mesaId, chair('PAYMASTER_2'), 'PM2', pm2);
    // (PAYMASTER_1 já está conectada = carteira do admin)

    // config + approve (o gatilho que ABRE as assinaturas)
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesa.mesaId}/config`, headers: H(pm), payload: { amountInBase: '250000000000', discountBps: 100, commissionBps: 200 } });
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/approve`, headers: H(pm), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201);
    const dealId = ap.json<{ deal: { id: string } }>().deal.id;

    // (sellerPtok = token de participante do Vendedor, obtido no join — usado p/ LER status/turnRole)

    // sequência esperada e as carteiras de cada papel
    const ORDER: [string, Wallet, string][] = [
      ['SELLER', seller, 'Vendedor'],
      ['PAYMASTER_1', pm1, 'Pay Master 1'],
      ['PAYMASTER_2', pm2, 'Pay Master 2'],
      ['BUYER', buyer, 'Comprador'],
    ];

    // logo após o approve: é a vez do VENDEDOR e de ninguém mais
    let st = await turnOf(app, mesa.mesaId, sellerPtok);
    expect(st.status).toBe('WAITING_SIGNATURES');
    expect(st.deal.turnRole).toBe('SELLER');
    expect(st.deal.validSignatures).toBe(0);

    for (let i = 0; i < ORDER.length; i++) {
      const [role, w, nome] = ORDER[i]!;
      // (a) é a vez deste papel
      st = await turnOf(app, mesa.mesaId, sellerPtok);
      expect(st.deal.turnRole, `vez de ${nome}`).toBe(role);

      // (b) a carteira do PRÓXIMO papel ainda NÃO pode assinar → OUT_OF_ORDER
      const next = ORDER[i + 1];
      if (next) {
        const [nrole, nw] = next;
        const early = await signTurn(app, dealId, nrole, nw);
        expect(early.statusCode, `${nrole} não pode assinar antes de ${role}`).toBe(409);
        expect(early.json<{ error: string }>().error).toBe('SIGNATURE_OUT_OF_ORDER');
      }

      // (c) a carteira da VEZ é chamada (recebe envelope), assina e é aceita
      const ok = await signTurn(app, dealId, role, w);
      expect(ok.statusCode, `${nome} assina na vez`).toBe(200);
      const after = ok.json<{ count: number; state: string }>();
      expect(after.count).toBe(i + 1); // avançou exatamente 1 assinatura
    }

    // todas assinaram → liquidou
    st = await turnOf(app, mesa.mesaId, sellerPtok);
    expect(st.deal.validSignatures).toBe(st.deal.requiredSignatures);
    expect(st.deal.turnRole).toBeNull();
    expect(['COMPLETED']).toContain(st.status);

    await app.close();
  }, 120_000);
});
