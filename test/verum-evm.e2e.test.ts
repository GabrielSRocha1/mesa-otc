/**
 * E2E REAL contra o VerumOTCEscrowEVM (anvil/Sepolia). Env-gated: roda apenas com o grupo
 * VERUM_EVM_* completo no ambiente (sem envs, a suíte é pulada — CI padrão não depende de chain).
 *
 *   anvil &  →  forge script Deploy.s.sol (ver runbook)  →
 *   VERUM_EVM_RPC_URL=... VERUM_EVM_CHAIN_ID=31337 VERUM_EVM_ESCROW_ADDRESS=0x... \
 *   VERUM_EVM_KEEPER_KEY=0x... VERUM_EVM_ATTESTOR_KEY=0x... VERUM_EVM_TBTC=0x... VERUM_EVM_TUSDT=0x... \
 *   npx vitest run test/verum-evm.e2e.test.ts
 */
import { describe, it, expect } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Role } from '../src/domain/types.js';
import type { Envelope } from '../src/engines/signature.js';

const VARS = ['VERUM_EVM_RPC_URL', 'VERUM_EVM_CHAIN_ID', 'VERUM_EVM_ESCROW_ADDRESS', 'VERUM_EVM_KEEPER_KEY', 'VERUM_EVM_ATTESTOR_KEY', 'VERUM_EVM_TBTC', 'VERUM_EVM_TUSDT'] as const;
const ready = VARS.every(k => !!process.env[k]);
const MASTER = 'e2e'.repeat(16).slice(0, 64); // determinístico: o keyring do app e o do teste derivam as MESMAS EOAs

describe.skipIf(!ready)('e2e — escrow canônico VerumOTCEscrowEVM (anvil)', () => {
  it('deal tUSDT↔tBTC: createTrade → 4 assinaturas (depósitos embutidos) → settle atômico on-chain', async () => {
    const env = Object.fromEntries(VARS.map(k => [k, process.env[k] as string]));
    const config = loadConfig({ OTC_ENV: 'dev', DATABASE_MODE: 'memory', SESSION_SECRET: 'x'.repeat(48), IDENTITY_MASTER_SECRET: MASTER, ...env });
    const app: App = await createApp(config, { autoSettle: false });
    try {
      const chainId = env.VERUM_EVM_CHAIN_ID!;
      const tusdt = env.VERUM_EVM_TUSDT! as `0x${string}`; const tbtc = env.VERUM_EVM_TBTC! as `0x${string}`;
      const kr = app.verumEvmKeyring!; // o MESMO keyring do app (índice por endereço preenchido na derivação)
      const owners: Record<Role, string> = { SELLER: 'e2e-seller', BUYER: 'e2e-buyer', PAYMASTER_1: 'e2e-pm1', PAYMASTER_2: 'e2e-pm2' };
      const addr = (r: Role) => kr.addressFor(owners[r]);
      const participants = (Object.keys(owners) as Role[]).map(role => ({ role, network: 'ethereum' as const, chainId, address: addr(role) }));

      // saldos: Vendedor entrega 50.000 tUSDT (+fee 3 bps); Comprador paga ~0,78 tBTC
      const amountIn = 50_000_000_000n; // 50.000 tUSDT (6 dec)
      await app.verumEvm!.mintToken(tusdt, addr('SELLER'), amountIn * 2n);
      await app.verumEvm!.mintToken(tbtc, addr('BUYER'), 200_000_000n); // 2 tBTC (8 dec)

      // create → connect → verify (congela termos e REGISTRA on-chain: createTrade real do PM1)
      let deal = await app.deals.create({
        assetIn: { network: 'ethereum', chainId, contractOrMint: tusdt }, assetOut: { network: 'ethereum', chainId, contractOrMint: tbtc },
        amountInBase: amountIn.toString(), discountBps: 150, maxSlippageBps: 50, maxPriceDriftBps: 100, expiresInSec: 3600, participants,
      }, addr('SELLER'));
      for (const p of participants) { if (p.role === 'SELLER') continue; deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address); }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('LIQUIDITY_VERIFIED');
      const meta = deal.onChain.ethereum?.meta as { tradeId: string; onChainExpiresAt: number } | undefined;
      expect(meta?.tradeId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(deal.expiresAt).toBeLessThanOrEqual(meta!.onChainExpiresAt * 1000); // clamp à janela de 40 min

      // open → fund (approve ERC20) → assina na ordem (recordApproval submete sellerSign/pmSign/buyerSign reais)
      await app.deals.open(deal.id, addr('SELLER'));
      await app.deals.fund(deal.id, 'SELLER', addr('SELLER'));
      await app.deals.fund(deal.id, 'BUYER', addr('BUYER'));
      for (const role of ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'] as Role[]) {
        const envp: Envelope = await app.deals.envelope(deal.id, role, addr(role));
        if (!envp.typedData) throw new Error('sem typedData EVM');
        const account = kr.accountFor(owners[role]);
        const signature = await account.signTypedData({ domain: envp.typedData.domain, types: envp.typedData.types, primaryType: 'DealApproval', message: envp.typedData.message });
        await app.deals.submitSignature(deal.id, { role, signer: account.address, scheme: 'secp256k1', signature, nonce: envp.payload.nonce }, account.address);
      }
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLEMENT_VALIDATION');
      const pre = await app.verumEvm!.getDealState(deal.id);
      expect(pre.status).toBe('FUNDED'); // READY_TO_SETTLE on-chain: os dois principais em custódia

      // settle (keeper): swap atômico das duas legs no contrato
      await app.settlement.settle(deal.id, 'keeper');
      deal = await app.deals.get(deal.id);
      expect(deal.state).toBe('SETTLED');
      const post = await app.verumEvm!.getDealState(deal.id);
      expect(post.status).toBe('SETTLED');

      // conservação: comprador recebeu os 50.000 tUSDT; vendedor recebeu os tBTC do comprador
      const usdtAsset = { network: 'ethereum', chainId, contractOrMint: tusdt } as Parameters<NonNullable<App['verumEvm']>['getBalance']>[1];
      const tbtcAsset = { network: 'ethereum', chainId, contractOrMint: tbtc } as Parameters<NonNullable<App['verumEvm']>['getBalance']>[1];
      expect(await app.verumEvm!.getBalance(addr('BUYER'), usdtAsset)).toBe(amountIn);
      expect(await app.verumEvm!.getBalance(addr('SELLER'), tbtcAsset)).toBeGreaterThan(0n);
    } finally { await app.close(); }
  }, 180_000);

  it('expiração on-chain: refund antes dos 40 min fica pendente (SETTLEMENT_NOT_ALLOWED)', async () => {
    const env = Object.fromEntries(VARS.map(k => [k, process.env[k] as string]));
    const config = loadConfig({ OTC_ENV: 'dev', DATABASE_MODE: 'memory', SESSION_SECRET: 'x'.repeat(48), IDENTITY_MASTER_SECRET: MASTER, ...env });
    const app: App = await createApp(config, { autoSettle: false });
    try {
      const chainId = env.VERUM_EVM_CHAIN_ID!;
      const tusdt = env.VERUM_EVM_TUSDT! as `0x${string}`; const tbtc = env.VERUM_EVM_TBTC! as `0x${string}`;
      const kr = app.verumEvmKeyring!;
      const owners: Record<Role, string> = { SELLER: 'exp-seller', BUYER: 'exp-buyer', PAYMASTER_1: 'exp-pm1', PAYMASTER_2: 'exp-pm2' };
      const addr = (r: Role) => kr.addressFor(owners[r]);
      const participants = (Object.keys(owners) as Role[]).map(role => ({ role, network: 'ethereum' as const, chainId, address: addr(role) }));
      const amountIn = 10_000_000_000n;
      await app.verumEvm!.mintToken(tusdt, addr('SELLER'), amountIn * 2n);
      await app.verumEvm!.mintToken(tbtc, addr('BUYER'), 100_000_000n);
      let deal = await app.deals.create({ assetIn: { network: 'ethereum', chainId, contractOrMint: tusdt }, assetOut: { network: 'ethereum', chainId, contractOrMint: tbtc }, amountInBase: amountIn.toString(), discountBps: 150, maxSlippageBps: 50, maxPriceDriftBps: 100, expiresInSec: 3600, participants }, addr('SELLER'));
      for (const p of participants) { if (p.role === 'SELLER') continue; deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address); }
      // reembolso ANTES da expiração da janela on-chain → o adapter recusa (fica PENDING p/ retryRefunds)
      await expect(app.verumEvm!.refund(deal.id, 0)).rejects.toMatchObject({ code: 'SETTLEMENT_NOT_ALLOWED' });
    } finally { await app.close(); }
  }, 120_000);
});
