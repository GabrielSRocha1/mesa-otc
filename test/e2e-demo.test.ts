/** E2E narrado (motor + simuladores em memória): aprovar → assinar na ordem obrigatória
 *  Vendedor → Pay Master 1 → Pay Master 2 → Comprador → liquidar. Demonstra o fluxo da mesa. */
import { describe, it, expect } from 'vitest';
import { makeApp, solWallet, type Wallet } from './helpers.js';
import type { App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';

const SOL = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
const USDC = { network: 'solana', contractOrMint: 'USDC1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC' };
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const idem = () => 'k-' + Math.random().toString(36).slice(2);
function richReaders(): BalanceReaders {
  return { native: async () => ({ amount: 1000 }), tokens: async () => [{ symbol: 'USDC', contract: USDC.contractOrMint, amount: 10 ** 9 }], priceUsdOf: async () => 150 };
}
async function walletLogin(app: App, w: Wallet): Promise<string> {
  const ch = (await app.api.inject({ method: 'GET', url: `/v1/auth/challenge?network=${w.network}&address=${w.address}` })).json<{ message: string; nonce: string }>();
  const issuedAt = ch.message.match(/Emitido em: (.+)/)![1]!; const expiresAt = ch.message.match(/Expira em: (.+)/)![1]!;
  const v = await app.api.inject({ method: 'POST', url: '/v1/auth/verify', payload: { network: w.network, address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message), issuedAt, expiresAt } });
  return v.json<{ token: string }>().token;
}
async function joinChair(app: App, pm: string, mesaId: string, chairId: string, name: string, w: Wallet): Promise<void> {
  const inv = (await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/chairs/${chairId}/invite`, headers: H(pm) })).json<{ inviteId: string; code: string }>();
  const ch = (await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${inv.inviteId}/challenge`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address } })).json<{ message: string; nonce: string }>();
  await app.api.inject({ method: 'POST', url: `/v1/mesa-invites/${inv.inviteId}/join`, payload: { code: inv.code, firstName: name, network: 'solana', address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message) } });
}
async function signRole(app: App, dealId: string, role: string, w: Wallet) {
  const tok = await walletLogin(app, w);
  const env = (await app.api.inject({ method: 'GET', url: `/v1/deals/${dealId}/approval-envelope`, headers: H(tok) })).json<{ message: string; payload: { nonce: string } }>();
  return app.api.inject({ method: 'POST', url: `/v1/deals/${dealId}/approvals`, headers: { ...H(tok), 'idempotency-key': idem() }, payload: { role, signature: await w.signMessage(env.message), nonce: env.payload.nonce } });
}
async function mesaStatus(app: App, mesaId: string, pm: string) {
  return (await app.api.inject({ method: 'GET', url: `/v1/portal/mesas/${mesaId}`, headers: H(pm) })).json<{ status: string; deal: { state: string; turnRole: string | null; validSignatures: number; requiredSignatures: number } | null }>();
}

describe('E2E demo — aprovar + assinaturas em ordem → liquidada', () => {
  it('Vendedor → PM1 → PM2 → Comprador', async () => {
    const { app } = await makeApp({ balanceReaders: richReaders(), autoSettle: true });

    // PM com carteira própria → a cadeira Pay Master 1 é a dele.
    const pm = (await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: `e2e-${Date.now()}@verum.test`, password: 'senha-forte-1' } })).json<{ token: string }>().token;
    const pmW = solWallet();
    await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: H(pm), payload: { address: pmW.address, network: 'solana' } });

    const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: H(pm), payload: { network: 'solana', chairs: [
      { role: 'SELLER', expectedAsset: SOL }, { role: 'BUYER', expectedAsset: USDC }, { role: 'PAYMASTER_1', expectedAsset: SOL }, { role: 'PAYMASTER_2', expectedAsset: SOL },
    ] } })).json<{ mesaId: string; chairs: { chairId: string; role: string }[] }>();
    const chair = (r: string) => mesa.chairs.find(c => c.role === r)!.chairId;
    const sW = solWallet(), bW = solWallet(), p2W = solWallet();
    await joinChair(app, pm, mesa.mesaId, chair('SELLER'), 'Vendedor', sW);
    await joinChair(app, pm, mesa.mesaId, chair('BUYER'), 'Comprador', bW);
    await joinChair(app, pm, mesa.mesaId, chair('PAYMASTER_2'), 'PayMaster2', p2W);
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesa.mesaId}/config`, headers: H(pm), payload: { amountInBase: '250000000000', buyerAmountInBase: '250000000000', discountBps: 100, commissionBps: 200, commissionPayer: 'SELLER' } });

    let st = await mesaStatus(app, mesa.mesaId, pm);
    console.log('\n──────── MESA PRONTA ────────');
    console.log('4 cadeiras conectadas + config salva → status:', st.status);

    // APROVAR = início do contrato.
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/approve`, headers: H(pm), payload: {} });
    expect(ap.statusCode, ap.body).toBe(201);
    const dealId = ap.json<{ deal: { id: string } }>().deal.id;
    st = await mesaStatus(app, mesa.mesaId, pm);
    console.log('\n──────── APROVAR OPERAÇÃO ────────');
    console.log('operação criada:', dealId);
    console.log('status:', st.status, '| vez de:', st.deal?.turnRole, '| assinaturas:', `${st.deal?.validSignatures}/${st.deal?.requiredSignatures}`);
    expect(st.deal?.turnRole).toBe('SELLER');

    // Fora de ordem (Comprador tenta primeiro) → recusado.
    const ooo = await signRole(app, dealId, 'BUYER', bW);
    console.log('\n──────── TENTATIVA FORA DE ORDEM (Comprador primeiro) ────────');
    console.log('recusado →', ooo.statusCode, ooo.json<{ error?: string }>().error);
    expect(ooo.statusCode).toBe(409);

    // Ordem obrigatória.
    console.log('\n──────── ASSINATURAS NA ORDEM ────────');
    const ordem: [string, Wallet, string][] = [['SELLER', sW, 'Vendedor'], ['PAYMASTER_1', pmW, 'Pay Master 1'], ['PAYMASTER_2', p2W, 'Pay Master 2'], ['BUYER', bW, 'Comprador']];
    for (const [role, w, nome] of ordem) {
      const r = await signRole(app, dealId, role, w);
      expect(r.statusCode, r.body).toBe(200);
      st = await mesaStatus(app, mesa.mesaId, pm);
      console.log(`✓ ${nome} assinou → status: ${st.status} | próxima vez: ${st.deal?.turnRole ?? '—'} | ${st.deal?.validSignatures}/${st.deal?.requiredSignatures}`);
    }

    // Liquidação.
    let deal = await app.deals.get(dealId);
    if (!['SETTLED', 'SETTLING', 'SETTLEMENT_VALIDATION'].includes(deal.state)) deal = await app.deals.get(dealId);
    if (deal.state === 'SETTLEMENT_VALIDATION' || deal.state === 'FULLY_SIGNED') { try { await app.settlement.settle(dealId, 'e2e'); } catch { /* autoSettle pode já ter rodado */ } }
    for (let i = 0; i < 20 && (await app.deals.get(dealId)).state !== 'SETTLED'; i++) { await new Promise(r => setTimeout(r, 50)); }
    deal = await app.deals.get(dealId);
    st = await mesaStatus(app, mesa.mesaId, pm);
    console.log('\n──────── LIQUIDAÇÃO ────────');
    console.log('estado da operação:', deal.state, '| status da mesa:', st.status);
    console.log('────────────────────────────\n');
    expect(deal.state).toBe('SETTLED');
    expect(st.status).toBe('COMPLETED');
    await app.close();
  }, 120_000);
});
