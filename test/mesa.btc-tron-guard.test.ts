/** Guard: BTC NATIVO ↔ Tron não é swappable (sem hashlock na Tron) — bloqueado na criação da mesa. */
import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers.js';

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const email = () => `bt-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;
const BTC = { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' };
const USDT_TRON = { network: 'tron', contractOrMint: 'TXYZ111111111111111111111111111111', decimals: 6, symbol: 'USDT' };
const WETH = { network: 'ethereum', contractOrMint: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, symbol: 'WETH' };

async function pmToken(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  return (await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: email(), password: 'senha-forte-1' } })).json<{ token: string }>().token;
}
const mk = (net: string, chairs: unknown[]) => ({ method: 'POST' as const, url: '/v1/portal/mesas', payload: { network: net, chairs } });

describe('Mesa · guard BTC nativo ↔ Tron', () => {
  it('BTC (Vendedor) ↔ Tron (Comprador) → rejeitado com motivo', async () => {
    const { app } = await makeApp(); const pm = await pmToken(app);
    const r = await app.api.inject({ ...mk('bitcoin', [{ role: 'SELLER', expectedAsset: BTC }, { role: 'BUYER', expectedAsset: USDT_TRON }, { role: 'PAYMASTER_1', expectedAsset: USDT_TRON }]), headers: H(pm) });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string; message: string }>().error).toBe('INVALID_INPUT');
    expect(r.json<{ message: string }>().message).toMatch(/Tron/);
    await app.close();
  });
  it('Tron (Vendedor) ↔ BTC (Comprador) → também rejeitado', async () => {
    const { app } = await makeApp(); const pm = await pmToken(app);
    const r = await app.api.inject({ ...mk('tron', [{ role: 'SELLER', expectedAsset: USDT_TRON }, { role: 'BUYER', expectedAsset: BTC }, { role: 'PAYMASTER_1', expectedAsset: USDT_TRON }]), headers: H(pm) });
    expect(r.statusCode).toBe(400);
    await app.close();
  });
  it('controle: BTC ↔ WETH (Ethereum) é permitido', async () => {
    const { app } = await makeApp(); const pm = await pmToken(app);
    const r = await app.api.inject({ ...mk('bitcoin', [{ role: 'SELLER', expectedAsset: BTC }, { role: 'BUYER', expectedAsset: WETH }, { role: 'PAYMASTER_1', expectedAsset: WETH }]), headers: H(pm) });
    expect(r.statusCode, r.body).toBe(201);
    await app.close();
  });
});
