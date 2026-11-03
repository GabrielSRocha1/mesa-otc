/**
 * E2E REAL contra o VerumOTCEscrowV2Tron (Shasta) — perna HTLC. Env-gated: roda com o grupo
 * TRON_* completo + TRON_ESCROW_V2_ADDRESS. Cenário BTC nativo (Vendedor, SIMULADOR local) ↔
 * tUSDT (Comprador, escrow V2 REAL na Shasta): createTradeV2 com htlcHash + sellerAsset=0
 * (perna externa), assinaturas signV2 na ordem canônica, settleV2 com a preimage — que fica
 * REVELADA no contrato (revealedPreimage) e destravaria o claim do BTC.
 * Pré-requisito: scripts/tron-e2e-prep.mts (mesmas carteiras de papel do TronDevKeyring).
 */
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signAs, type Wallet } from './helpers.js';
import { testSigning, tronMessageHash } from '../src/engines/signature.js';
import type { Role } from '../src/domain/types.js';

const VARS = ['TRON_FULL_HOST', 'TRON_CHAIN_ID', 'TRON_ESCROW_ADDRESS', 'TRON_ESCROW_V2_ADDRESS', 'TRON_EXECUTOR_KEY', 'TRON_ATTESTOR_KEY', 'TRON_TUSDT', 'TRON_TBTC'] as const;
const ready = VARS.every(k => !!process.env[k]);
const MASTER = 'e2e'.repeat(22).slice(0, 64); // MESMO master do tron-e2e-prep.mts

describe.skipIf(!ready)('e2e — escrow VerumOTCEscrowV2Tron real (Shasta): perna HTLC', () => {
  it('BTC nativo (externo) ↔ tUSDT: createTradeV2 com htlcHash → signV2 → settleV2 revela a preimage', async () => {
    const env = Object.fromEntries(VARS.map(k => [k, process.env[k] as string]));
    const config = loadConfig({ OTC_ENV: 'dev', DATABASE_MODE: 'memory', SESSION_SECRET: 'x'.repeat(48), IDENTITY_MASTER_SECRET: MASTER, TRON_CONFIRMATIONS: '1', ...env });
    const btc = testSigning.bitcoin('bcrt'); // vendedor de BTC (perna no simulador local)
    const app: App = await createApp(config, {
      autoSettle: false,
      // Vendedor (perna externa BTC) recebe o tUSDT NESTA carteira Tron — override de teste
      // (sem mesa/portal): o registro resolve o payout por aqui.
      tronAddressOf: async (_dealId: string, role: Role) => role === 'SELLER' ? app.tronKeyring!.addressFor('e2e-seller') : null,
    });
    try {
      const chainId = app.adapters.require('tron').chain.chainId;
      expect(app.verumTronV2, 'adapter V2 deve substituir o V1 com TRON_ESCROW_V2_ADDRESS').toBeTruthy();
      const kr = app.tronKeyring!;
      const owners: Partial<Record<Role, string>> = { BUYER: 'e2e-buyer', PAYMASTER_1: 'e2e-pm1', PAYMASTER_2: 'e2e-pm2' };
      const addr = (r: Role) => kr.addressFor(owners[r] as string);
      const tronWalletOf = (r: Role): Wallet => {
        const priv = hexToBytes(kr.privateKeyFor(owners[r] as string).slice(2));
        const sign = (m: string) => {
          const s = secp256k1.sign(tronMessageHash(m), priv, { prehash: false, format: 'recovered' });
          return '0x' + Buffer.from(new Uint8Array([...s.slice(1), (s[0] as number) + 27])).toString('hex');
        };
        return { network: 'tron', chainId, address: addr(r), async sign(e) { return sign(e.message); }, async signMessage(m) { return sign(m); } };
      };
      const btcWallet: Wallet = { network: 'bitcoin', chainId: 'regtest', address: btc.address, async sign(e) { return btc.sign(e.message); }, async signMessage(m) { return btc.sign(m); } };
      const participants = [
        { role: 'SELLER' as Role, network: 'bitcoin' as const, chainId: 'regtest', address: btc.address },
        { role: 'PAYMASTER_1' as Role, network: 'tron' as const, chainId, address: addr('PAYMASTER_1') },
        { role: 'PAYMASTER_2' as Role, network: 'tron' as const, chainId, address: addr('PAYMASTER_2') },
        { role: 'BUYER' as Role, network: 'tron' as const, chainId, address: addr('BUYER') },
      ];
      const tusdt = env.TRON_TUSDT!;
      const sats = 1_000_000n; // 0.01 BTC
      app.local!.bitcoin.mint(btc.address, null, 50_000_000n); // financia o vendedor no simulador BTC
      let deal = await app.deals.create({
        assetIn: { network: 'bitcoin', chainId: 'regtest', contractOrMint: null },
        assetOut: { network: 'tron', chainId, contractOrMint: tusdt },
        amountInBase: sats.toString(), discountBps: 0, maxSlippageBps: 50, maxPriceDriftBps: 100, expiresInSec: 3600, participants,
      }, btc.address);
      for (const p of participants) { if (p.role === 'SELLER') continue; deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address); }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('LIQUIDITY_VERIFIED');
      expect(deal.terms?.route.htlcHash, 'rota HTLC deve ter htlcHash').toMatch(/^[0-9a-f]{64}$/);

      // OPEN → registro on-chain nas DUAS pernas: BTC no simulador local, tron = createTradeV2
      // REAL na Shasta com sellerAsset=0 (perna externa) e o htlcHash do swap.
      await app.deals.open(deal.id, btc.address);
      deal = await app.deals.get(deal.id);
      const meta = deal.onChain.tron?.meta as { tradeId: string } | undefined;
      expect(meta?.tradeId).toMatch(/^0x[0-9a-f]{64}$/);
      const pre = await app.verumTronV2!.getDealState(deal.id);
      expect(pre.status).toBe('REGISTERED');

      // Funding: perna BTC no simulador (lock); perna tUSDT = approve do comprador na Shasta.
      const legs = [...deal.terms!.legs].sort((a, b) => (a.mode === 'HTLC' ? 1 : 0) - (b.mode === 'HTLC' ? 1 : 0));
      for (const leg of legs) await app.deals.fund(deal.id, leg.from, leg.from === 'SELLER' ? btc.address : addr(leg.from));

      // Assinaturas na ordem obrigatória — Vendedor assina o envelope com a carteira BTC (BIP-137);
      // o passo on-chain dele (signV2) sai pela carteira Tron registrada nos termos.
      for (const role of ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'] as Role[]) {
        await signAs(app, deal.id, role, role === 'SELLER' ? btcWallet : tronWalletOf(role));
      }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLEMENT_VALIDATION');

      await app.settlement.settle(deal.id, 'keeper');
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLED');
      const post = await app.verumTronV2!.getDealState(deal.id);
      expect(post.status).toBe('SETTLED');
      // A preimage do swap fica REVELADA no contrato — é ela que destrava o claim do BTC.
      const revealed = await app.verumTronV2!.revealedPreimage(deal.id);
      expect(revealed).toMatch(/^[0-9a-f]{64}$/);
    } finally { await app.close(); }
  }, 900_000);

  it('TRX NATIVO (Vendedor) ↔ tUSDT: deal escrow direto — TRX entra como callValue no signV2 e sai no settle', async () => {
    const env = Object.fromEntries(VARS.map(k => [k, process.env[k] as string]));
    const config = loadConfig({ OTC_ENV: 'dev', DATABASE_MODE: 'memory', SESSION_SECRET: 'x'.repeat(48), IDENTITY_MASTER_SECRET: MASTER, TRON_CONFIRMATIONS: '1', ...env });
    const app: App = await createApp(config, { autoSettle: false });
    try {
      const chainId = app.adapters.require('tron').chain.chainId;
      const kr = app.tronKeyring!;
      const owners: Record<Role, string> = { SELLER: 'e2e-seller', BUYER: 'e2e-buyer', PAYMASTER_1: 'e2e-pm1', PAYMASTER_2: 'e2e-pm2' };
      const addr = (r: Role) => kr.addressFor(owners[r]);
      const tronWalletOf = (r: Role): Wallet => {
        const priv = hexToBytes(kr.privateKeyFor(owners[r]).slice(2));
        const sign = (m: string) => {
          const s = secp256k1.sign(tronMessageHash(m), priv, { prehash: false, format: 'recovered' });
          return '0x' + Buffer.from(new Uint8Array([...s.slice(1), (s[0] as number) + 27])).toString('hex');
        };
        return { network: 'tron', chainId, address: addr(r), async sign(e) { return sign(e.message); }, async signMessage(m) { return sign(m); } };
      };
      const participants = (Object.keys(owners) as Role[]).map(role => ({ role, network: 'tron' as const, chainId, address: addr(role) }));
      const tusdt = env.TRON_TUSDT!;
      const trxAsset = { network: 'tron', chainId, contractOrMint: null } as const;
      const usdtAsset = { network: 'tron', chainId, contractOrMint: tusdt } as const;
      const amountSun = 100_000_000n; // 100 TRX
      const sellerUsdtBefore = await app.verumTronV2!.getBalance(addr('SELLER'), usdtAsset as never);
      const buyerTrxBefore = await app.verumTronV2!.getBalance(addr('BUYER'), trxAsset as never);

      let deal = await app.deals.create({
        assetIn: trxAsset, assetOut: usdtAsset,
        amountInBase: amountSun.toString(), discountBps: 0, maxSlippageBps: 50, maxPriceDriftBps: 100, expiresInSec: 3600, participants,
      }, addr('SELLER'));
      for (const p of participants) { if (p.role === 'SELLER') continue; deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address); }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('LIQUIDITY_VERIFIED');
      const buyerAmount = BigInt(deal.terms!.legs.find(l => l.from === 'BUYER')!.amountBase);

      await app.deals.open(deal.id, addr('SELLER'));
      for (const leg of [...deal.terms!.legs]) await app.deals.fund(deal.id, leg.from, addr(leg.from));
      for (const role of ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'] as Role[]) {
        await signAs(app, deal.id, role, tronWalletOf(role));
      }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLEMENT_VALIDATION');

      await app.settlement.settle(deal.id, 'keeper');
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLED');
      const post = await app.verumTronV2!.getDealState(deal.id);
      expect(post.status).toBe('SETTLED');
      // Vendedor recebe o tUSDT EXATO da perna do comprador (token: sem poluição de taxas).
      expect(await app.verumTronV2!.getBalance(addr('SELLER'), usdtAsset as never) - sellerUsdtBefore).toBe(buyerAmount);
      // Comprador recebe os 100 TRX nativos; o delta líquido desconta as taxas das próprias txs
      // (approve + signV2), então a asserção é de ganho positivo substancial, não de igualdade.
      const buyerTrxDelta = await app.verumTronV2!.getBalance(addr('BUYER'), trxAsset as never) - buyerTrxBefore;
      expect(buyerTrxDelta).toBeGreaterThan(0n);
    } finally { await app.close(); }
  }, 900_000);
});
