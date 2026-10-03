/**
 * E2E REAL contra o VerumOTCEscrowTron (Shasta/Nile). Env-gated: roda apenas com o grupo
 * TRON_* completo no ambiente. Pré-requisito: scripts/tron-e2e-prep.mts (financia TRX e
 * mocks nas carteiras de papel do TronDevKeyring com o MESMO master deste teste).
 */
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { tronMessageHash } from '../src/engines/signature.js';
import type { Role } from '../src/domain/types.js';

const VARS = ['TRON_FULL_HOST', 'TRON_CHAIN_ID', 'TRON_ESCROW_ADDRESS', 'TRON_EXECUTOR_KEY', 'TRON_ATTESTOR_KEY', 'TRON_TUSDT', 'TRON_TBTC'] as const;
const ready = VARS.every(k => !!process.env[k]);
const MASTER = 'e2e'.repeat(22).slice(0, 64); // MESMO master do tron-e2e-prep.mts

describe.skipIf(!ready)('e2e — escrow VerumOTCEscrowTron real (Shasta)', () => {
  it('deal tUSDT↔tBTC: createTrade → 4 assinaturas (TIP-712) → settle atômico on-chain', async () => {
    const env = Object.fromEntries(VARS.map(k => [k, process.env[k] as string]));
    const config = loadConfig({ OTC_ENV: 'dev', DATABASE_MODE: 'memory', SESSION_SECRET: 'x'.repeat(48), IDENTITY_MASTER_SECRET: MASTER, TRON_CONFIRMATIONS: '1', ...env });
    const app: App = await createApp(config, { autoSettle: false });
    try {
      const chainId = app.adapters.require('tron').chain.chainId;
      const kr = app.tronKeyring!;
      const owners: Record<Role, string> = { SELLER: 'e2e-seller', BUYER: 'e2e-buyer', PAYMASTER_1: 'e2e-pm1', PAYMASTER_2: 'e2e-pm2' };
      const addr = (r: Role) => kr.addressFor(owners[r]);
      const signTip191 = (r: Role, message: string) => {
        const priv = hexToBytes(kr.privateKeyFor(owners[r]).slice(2));
        const s = secp256k1.sign(tronMessageHash(message), priv, { prehash: false, format: 'recovered' });
        return '0x' + Buffer.from(new Uint8Array([...s.slice(1), (s[0] as number) + 27])).toString('hex');
      };
      const participants = (Object.keys(owners) as Role[]).map(role => ({ role, network: 'tron' as const, chainId, address: addr(role) }));
      const tusdt = env.TRON_TUSDT!; const tbtc = env.TRON_TBTC!;
      const amountIn = 50_000_000_000n; // 50.000 tUSDT (6 dec)

      const usdtAsset = { network: 'tron', chainId, contractOrMint: tusdt } as Parameters<NonNullable<App['verumTron']>['getBalance']>[1];
      const tbtcAsset = { network: 'tron', chainId, contractOrMint: tbtc } as Parameters<NonNullable<App['verumTron']>['getBalance']>[1];
      const buyerUsdtBefore = await app.verumTron!.getBalance(addr('BUYER'), usdtAsset);
      const sellerTbtcBefore = await app.verumTron!.getBalance(addr('SELLER'), tbtcAsset);

      let deal = await app.deals.create({
        assetIn: { network: 'tron', chainId, contractOrMint: tusdt }, assetOut: { network: 'tron', chainId, contractOrMint: tbtc },
        amountInBase: amountIn.toString(), discountBps: 150, maxSlippageBps: 50, maxPriceDriftBps: 100, expiresInSec: 3600, participants,
      }, addr('SELLER'));
      for (const p of participants) { if (p.role === 'SELLER') continue; deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address); }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('LIQUIDITY_VERIFIED'); // registerDeal = createTrade REAL do PM1 na Shasta
      const meta = deal.onChain.tron?.meta as { tradeId: string; onChainExpiresAt: number } | undefined;
      expect(meta?.tradeId).toMatch(/^0x[0-9a-f]{64}$/);

      await app.deals.open(deal.id, addr('SELLER'));
      await app.deals.fund(deal.id, 'SELLER', addr('SELLER'));  // approve TRC-20 (principal + fee)
      await app.deals.fund(deal.id, 'BUYER', addr('BUYER'));
      for (const role of ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'] as Role[]) {
        const envp = await app.deals.envelope(deal.id, role, addr(role));
        await app.deals.submitSignature(deal.id, { role, signer: addr(role), scheme: 'secp256k1', signature: signTip191(role, envp.message), nonce: envp.payload.nonce }, addr(role));
      }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLEMENT_VALIDATION');
      const pre = await app.verumTron!.getDealState(deal.id);
      expect(pre.status).toBe('FUNDED'); // READY_TO_SETTLE: principais em custódia no escrow

      await app.settlement.settle(deal.id, 'keeper');
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLED');
      const post = await app.verumTron!.getDealState(deal.id);
      expect(post.status).toBe('SETTLED');

      expect(await app.verumTron!.getBalance(addr('BUYER'), usdtAsset) - buyerUsdtBefore).toBe(amountIn);
      expect(await app.verumTron!.getBalance(addr('SELLER'), tbtcAsset) - sellerTbtcBefore).toBeGreaterThan(0n);
    } finally { await app.close(); }
  }, 900_000);
});
