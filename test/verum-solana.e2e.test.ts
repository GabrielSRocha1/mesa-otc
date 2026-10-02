/**
 * E2E REAL contra o programa verum_otc (solana-test-validator/devnet). Env-gated: roda apenas
 * com o grupo SOLANA_* completo no ambiente (CI padrão pula).
 *
 * Pré-requisitos (ver runbook): validator rodando, programa deployado, initialize_config feito
 * pela upgrade authority, mints registrados via solana-add-token.ts e carteiras demo financiadas.
 * As 4 carteiras da mesa são as do DemoMesaKeyring (credenciais demo default) — as MESMAS que o
 * app usa; o adapter assina as transações de papel server-side (seller_sign deposita de verdade).
 */
import { describe, it, expect } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DemoMesaKeyring, demoSecret } from '../src/portal/demo.js';
import type { Role } from '../src/domain/types.js';

const VARS = ['SOLANA_RPC_URL', 'SOLANA_CHAIN_ID', 'SOLANA_PROGRAM_ID', 'SOLANA_EXECUTOR_KEYPAIR', 'SOLANA_ATTESTOR_KEYPAIR', 'SOLANA_TUSDT_MINT', 'SOLANA_TBTC_MINT'] as const;
const ready = VARS.every(k => !!process.env[k]);

describe.skipIf(!ready)('e2e — programa verum_otc real (solana-test-validator)', () => {
  it('deal tUSDT↔tBTC: create_trade → 4 assinaturas (depósitos via seller/buyer_sign) → settle atômico', async () => {
    const env = Object.fromEntries(VARS.map(k => [k, process.env[k] as string]));
    const config = loadConfig({ OTC_ENV: 'dev', DATABASE_MODE: 'memory', SESSION_SECRET: 'x'.repeat(48), ...env });
    const app: App = await createApp(config, { autoSettle: false });
    try {
      const chainId = app.adapters.require('solana').chain.chainId; // '103' → 'devnet'
      const kr = new DemoMesaKeyring(demoSecret(config.DEMO_EMAIL, config.DEMO_PASSWORD));
      const roleMap: Record<Role, 'SELLER' | 'BUYER' | 'PAYMASTER_1' | 'PAYMASTER_2'> = { SELLER: 'SELLER', BUYER: 'BUYER', PAYMASTER_1: 'PAYMASTER_1', PAYMASTER_2: 'PAYMASTER_2' };
      const addr = (r: Role) => kr.addressFor(roleMap[r]);
      const participants = (Object.keys(roleMap) as Role[]).map(role => ({ role, network: 'solana' as const, chainId, address: addr(role) }));

      const tusdt = env.SOLANA_TUSDT_MINT!; const tbtc = env.SOLANA_TBTC_MINT!;
      const amountIn = 50_000_000_000n; // 50.000 tUSDT (6 dec)

      let deal = await app.deals.create({
        assetIn: { network: 'solana', chainId, contractOrMint: tusdt }, assetOut: { network: 'solana', chainId, contractOrMint: tbtc },
        amountInBase: amountIn.toString(), discountBps: 150, maxSlippageBps: 50, maxPriceDriftBps: 100, expiresInSec: 3600, participants,
      }, addr('SELLER'));
      for (const p of participants) { if (p.role === 'SELLER') continue; deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address); }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('LIQUIDITY_VERIFIED'); // registerDeal fez attest_wallet ×4 + create_trade REAIS
      const meta = deal.onChain.solana?.meta as { tradeId: string; onChainExpiresAt: number } | undefined;
      expect(meta?.tradeId).toMatch(/^(0x)?[0-9a-f]{64}$/);
      expect(deal.expiresAt).toBeLessThanOrEqual(meta!.onChainExpiresAt * 1000);

      await app.deals.open(deal.id, addr('SELLER'));
      await app.deals.fund(deal.id, 'SELLER', addr('SELLER'));   // Solana: checagem de saldo na ATA
      await app.deals.fund(deal.id, 'BUYER', addr('BUYER'));
      for (const role of ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'] as Role[]) {
        const envp = await app.deals.envelope(deal.id, role, addr(role));
        const signature = kr.signMessage(roleMap[role], envp.message); // ed25519 — igual à Verum Wallet
        await app.deals.submitSignature(deal.id, { role, signer: addr(role), scheme: 'ed25519', signature, nonce: envp.payload.nonce }, addr(role));
      }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLEMENT_VALIDATION');
      const pre = await app.verumSolana!.getDealState(deal.id);
      expect(pre.status).toBe('FUNDED'); // READY_TO_SETTLE: os dois principais nas ATAs de escrow do trade PDA

      await app.settlement.settle(deal.id, 'keeper');
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLED');
      const post = await app.verumSolana!.getDealState(deal.id);
      expect(post.status).toBe('SETTLED');

      // conservação: comprador recebeu os 50.000 tUSDT na ATA dele
      const usdtAsset = { network: 'solana', chainId, contractOrMint: tusdt } as Parameters<NonNullable<App['verumSolana']>['getBalance']>[1];
      expect(await app.verumSolana!.getBalance(addr('BUYER'), usdtAsset)).toBe(amountIn);
    } finally { await app.close(); }
  }, 300_000);
});
