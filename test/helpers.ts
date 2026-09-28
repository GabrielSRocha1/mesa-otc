/** Utilitários de teste: relógio controlável, app com simuladores locais, carteiras efêmeras por rede e fluxo completo. */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp, LOCAL_TOKENS, type App, type AppOverrides } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testSigning, type Envelope } from '../src/engines/signature.js';
import { SIGNING_ORDER, type Deal, type Network, type Role } from '../src/domain/types.js';

export interface Wallet { network: Network; chainId: string; address: string; sign(envelope: Envelope): Promise<string>; signMessage(m: string): Promise<string> }
export class Clock { t = Date.parse('2026-09-24T12:00:00Z'); now = () => this.t; advance(ms: number) { this.t += ms; } }

export function evmWallet(): Wallet { const acct = privateKeyToAccount(generatePrivateKey()); return { network: 'ethereum', chainId: '31337', address: acct.address, async sign(env) { if (!env.typedData) throw new Error('sem typedData'); return acct.signTypedData({ domain: env.typedData.domain, types: env.typedData.types, primaryType: 'DealApproval', message: env.typedData.message }); }, async signMessage(m) { return acct.signMessage({ message: m }); } }; }
export function solWallet(): Wallet { const k = testSigning.solana(); return { network: 'solana', chainId: 'localnet', address: k.address, async sign(env) { return k.sign(env.message); }, async signMessage(m) { return k.sign(m); } }; }
export function btcWallet(): Wallet { const k = testSigning.bitcoin('bcrt'); return { network: 'bitcoin', chainId: 'regtest', address: k.address, async sign(env) { return k.sign(env.message); }, async signMessage(m) { return k.sign(m); } }; }

export async function makeApp(over: AppOverrides & { env?: Record<string, string> } = {}): Promise<{ app: App; clock: Clock }> {
  const clock = new Clock(); const { env, ...rest } = over;
  const config = loadConfig({ OTC_ENV: 'dev', DATABASE_MODE: 'memory', SESSION_SECRET: 'x'.repeat(48), ...(env ?? {}) });
  const app = await createApp(config, { now: clock.now, ...rest }); return { app, clock };
}
export const ASSETS = {
  SOL: { network: 'solana' as const, chainId: 'localnet', contractOrMint: null },
  USDC_SOL: { network: 'solana' as const, chainId: 'localnet', contractOrMint: LOCAL_TOKENS.usdcSol },
  USDT_SOL: { network: 'solana' as const, chainId: 'localnet', contractOrMint: LOCAL_TOKENS.usdtSol },
  ETH: { network: 'ethereum' as const, chainId: '31337', contractOrMint: null },
  USDT_ETH: { network: 'ethereum' as const, chainId: '31337', contractOrMint: LOCAL_TOKENS.usdtEth },
  USDC_ETH: { network: 'ethereum' as const, chainId: '31337', contractOrMint: LOCAL_TOKENS.usdcEth },
  BTC: { network: 'bitcoin' as const, chainId: 'regtest', contractOrMint: null }
};
export type AssetRef = { network: Network; chainId: string; contractOrMint: string | null };
export type Parts = Partial<Record<Role, Wallet>> & { SELLER: Wallet; BUYER: Wallet; PAYMASTER_1: Wallet };
export const participantsOf = (p: Parts) => (Object.entries(p) as [Role, Wallet][]).map(([role, w]) => ({ role, network: w.network, chainId: w.chainId, address: w.address }));

/** Cria e prepara a Deal até LIQUIDITY_VERIFIED (todas as carteiras conectadas, verificações feitas). */
export async function prepareDeal(app: App, parts: Parts, opts: { assetIn?: AssetRef; assetOut?: AssetRef; amountInBase?: string; discountBps?: number; expiresInSec?: number; skipConnect?: Role[] } = {}): Promise<Deal> {
  const assetIn = opts.assetIn ?? ASSETS.SOL; const assetOut = opts.assetOut ?? ASSETS.USDC_SOL; const amount = opts.amountInBase ?? '250000000000'; // 250 SOL ≈ US$ 37,8k (abaixo do limite de risco)
  const local = app.local!; const chainOf = (n: Network) => n === 'ethereum' ? local.evm : n === 'solana' ? local.solana : local.bitcoin;
  chainOf(assetIn.network).mint(parts.SELLER.address, assetIn.contractOrMint, BigInt(amount) * 2n);
  chainOf(assetOut.network).mint(parts.BUYER.address, assetOut.contractOrMint, 10n ** 15n);
  let deal = await app.deals.create({ assetIn, assetOut, amountInBase: amount, discountBps: opts.discountBps ?? 150, maxSlippageBps: 50, maxPriceDriftBps: 100, expiresInSec: opts.expiresInSec ?? 3600, participants: participantsOf(parts) }, parts.SELLER.address);
  for (const [role, w] of Object.entries(parts) as [Role, Wallet][]) { if (role === 'SELLER' || opts.skipConnect?.includes(role)) continue; deal = await app.deals.connectWallet(deal.id, role, w.address, w.address); }
  return app.deals.get(deal.id);
}
export async function signAs(app: App, dealId: string, role: Role, w: Wallet, mutate?: (env: Envelope) => Envelope): Promise<{ count: number; state: string }> {
  let env = await app.deals.envelope(dealId, role, w.address); if (mutate) env = mutate(env);
  const signature = await w.sign(env); const r = await app.deals.submitSignature(dealId, { role, signer: w.address, scheme: env.scheme, signature, nonce: env.payload.nonce }, w.address);
  return { count: r.count, state: r.deal.state };
}
/** Fluxo até FULLY_SIGNED/SETTLEMENT_VALIDATION (funding + N assinaturas). */
export async function fullySign(app: App, dealId: string, parts: Parts): Promise<Deal> {
  const d = await app.deals.get(dealId); if (d.state === 'LIQUIDITY_VERIFIED') await app.deals.open(dealId, parts.SELLER.address);
  const t = (await app.deals.get(dealId)).terms!; const order = [...t.legs].sort((a, b) => (a.mode === 'HTLC' ? 1 : 0) - (b.mode === 'HTLC' ? 1 : 0));
  for (const leg of order) await app.deals.fund(dealId, leg.from, parts[leg.from]!.address);
  // Assina na ordem obrigatória: Vendedor → PM1 → PM2 → Comprador.
  for (const role of SIGNING_ORDER) { const w = parts[role]; if (w) await signAs(app, dealId, role, w); }
  return app.deals.get(dealId);
}
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
