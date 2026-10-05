/** v4 — escrow dinâmico (2–4 cadeiras), plano de liquidação (HTLC/cross-chain) e anti-scam de tokens. */
import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers.js';
import { deriveSettlementPlan } from '../src/mesa/settlementPlan.js';
import { registryChecker, composeCheckers, validateMesaTokens, type TokenSecurityChecker } from '../src/mesa/antiscam.js';
import type { MesaChair } from '../src/mesa/types.js';

const chair = (role: MesaChair['role'], network: string, contractOrMint: string | null, symbol: string, decimals = 6): MesaChair =>
  ({ chairId: 'ch_' + role, role, expectedAsset: { network, contractOrMint, decimals, symbol }, wallet: null });

const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

describe('settlementPlan — derivação determinística', () => {
  it('mesma rede → ESCROW_DIRECT', () => {
    const p = deriveSettlementPlan([chair('SELLER', 'tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT'), chair('BUYER', 'tron', 'TXYZ111111111111111111111111111111', 'USDC')]);
    expect(p?.mode).toBe('ESCROW_DIRECT');
  });
  it('redes diferentes → CROSS_CHAIN via CCIP', () => {
    const p = deriveSettlementPlan([chair('SELLER', 'polygon', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT'), chair('BUYER', 'tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT')]);
    expect(p?.mode).toBe('CROSS_CHAIN');
    expect(p?.bridge).toBe('CCIP');
  });
  it('BTC nativo em um lado → HTLC_BTC com timelocks assimétricos', () => {
    const p = deriveSettlementPlan([chair('SELLER', 'bitcoin', null, 'BTC', 8), chair('BUYER', 'tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT')]);
    expect(p?.mode).toBe('HTLC_BTC');
    expect(p?.htlc?.btcSide).toBe('SELLER');
    // BTC trancado MUITO mais tempo que a janela do escrow — quem revela a preimage nunca fica sem claim.
    expect(p!.htlc!.btcLockBlocks * 600).toBeGreaterThan(p!.htlc!.tokenLockSeconds * 10);
  });
});

describe('anti-scam — registro oficial + camadas compostas', () => {
  it('USDT com contrato divergente do canônico → bloqueia com motivo nominal', async () => {
    const motivos = await validateMesaTokens([chair('SELLER', 'ethereum', '0xDEAD00000000000000000000000000000000BEEF', 'USDT')], registryChecker());
    expect(motivos).toHaveLength(1);
    expect(motivos[0]).toContain('Vendedor');
    expect(motivos[0]).toContain('golpe');
  });
  it('USDT canônico, BTC nativo e símbolo fora do registro passam', async () => {
    const motivos = await validateMesaTokens([
      chair('SELLER', 'ethereum', USDT_ETH, 'USDT'),
      chair('BUYER', 'bitcoin', null, 'BTC', 8),
      chair('SELLER', 'ethereum', '0x1234000000000000000000000000000000001234', 'XPTO'),
    ], registryChecker());
    expect(motivos).toHaveLength(0);
  });
  it('allowlist de dev trata tokens de teste como canônicos', async () => {
    const motivos = await validateMesaTokens([chair('BUYER', 'solana', 'USDC1111111111111111111111111111111111111111', 'USDC')], registryChecker({ allowed: ['USDC1111111111111111111111111111111111111111'] }));
    expect(motivos).toHaveLength(0);
  });
  it('camada remota (Verum Wallet) compõe: veredito malicioso bloqueia mesmo com registro ok', async () => {
    const remote: TokenSecurityChecker = { check: async () => ({ ok: false, reason: 'marcado como malicioso pela Verum Wallet' }) };
    const motivos = await validateMesaTokens([chair('SELLER', 'ethereum', USDT_ETH, 'USDT')], composeCheckers(registryChecker(), remote));
    expect(motivos).toHaveLength(1);
    expect(motivos[0]).toContain('malicioso');
  });
});

describe('API — cadeiras dinâmicas e 403 anti-scam no approve', () => {
  const pmHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
  const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;

  it('mesa bilateral (2 cadeiras) é aceita; 1 cadeira e PM2 sem PM1 são rejeitadas; plano exposto no DTO', async () => {
    const { app } = await makeApp({});
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail('v4'), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const mk = (chairs: unknown[]) => app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { network: 'tron', chairs } });

    const bi = await mk([
      { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
      { role: 'BUYER', expectedAsset: { network: 'tron', contractOrMint: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' } },
    ]);
    expect(bi.statusCode, bi.body).toBe(201);
    const view = bi.json<{ settlement: { mode: string; htlc?: { btcSide: string } } }>();
    expect(view.settlement.mode).toBe('HTLC_BTC');
    expect(view.settlement.htlc?.btcSide).toBe('SELLER');

    expect((await mk([{ role: 'SELLER', expectedAsset: { network: 'tron', contractOrMint: null, decimals: 6, symbol: 'TRX' } }])).statusCode).toBe(400);
    const pm2SemPm1 = await mk([
      { role: 'SELLER', expectedAsset: { network: 'tron', contractOrMint: null, decimals: 6, symbol: 'TRX' } },
      { role: 'BUYER', expectedAsset: { network: 'tron', contractOrMint: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' } },
      { role: 'PAYMASTER_2', expectedAsset: { network: 'tron', contractOrMint: null, decimals: 6, symbol: 'TRX' } },
    ]);
    expect(pm2SemPm1.statusCode).toBe(400);
    await app.close();
  }, 60_000);

  it('approve trava com 403 quando um token se passa por USDT com contrato falso', async () => {
    const { app } = await makeApp({});
    const r = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail('scam'), password: 'senha-forte-1' } });
    const token = r.json<{ token: string }>().token;
    const mesa = (await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { network: 'ethereum', chairs: [
      { role: 'SELLER', expectedAsset: { network: 'ethereum', contractOrMint: '0xDEAD00000000000000000000000000000000BEEF', decimals: 6, symbol: 'USDT' } },
      { role: 'BUYER', expectedAsset: { network: 'ethereum', contractOrMint: USDT_ETH, decimals: 6, symbol: 'USDT' } },
    ] } })).json<{ mesaId: string }>();
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesa.mesaId}/approve`, headers: pmHeaders(token), payload: {} });
    expect(ap.statusCode, ap.body).toBe(403);
    const motivos = ap.json<{ details: { motivos: string[] } }>().details.motivos.join(' | ');
    expect(motivos).toContain('Vendedor');
    expect(motivos).toContain('golpe');
    await app.close();
  }, 60_000);
});
