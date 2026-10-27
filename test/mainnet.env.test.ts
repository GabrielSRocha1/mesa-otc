/**
 * Dual-ambiente por mesa (mesa.environment='mainnet'): registry ambiente-consciente, regra de par
 * mainnet (BTC↔Ethereum), hash back-compat, leitura de saldos por ambiente e roteamento fail-closed.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, btcWallet, evmWallet } from './helpers.js';
import { AdapterRegistry } from '../src/adapters/types.js';
import { computeDealHash, type Terms } from '../src/domain/types.js';
import { getChain } from '../src/chains/registry.js';
import { LocalChainAdapter } from '../src/adapters/local.js';
import type { MesaChair } from '../src/mesa/types.js';

const pmHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
const uniqueEmail = () => `mn-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`;
const BTC = { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' };
const ETH = { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' };
const USDT_TRON = { network: 'tron', contractOrMint: 'TXYZ111111111111111111111111111111', decimals: 6, symbol: 'USDT' };
const GAS_ETH = { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' };

async function registerPm(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  return (await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM', email: uniqueEmail(), password: 'senha-forte-1' } })).json<{ token: string }>().token;
}

describe('dual-ambiente — registry por env', () => {
  it('default testnet preserva o comportamento; mainnet é fail-closed sem adapter', () => {
    const reg = new AdapterRegistry();
    const fake = { chain: { network: 'ethereum', chainId: '11155111' } } as never;
    reg.register(fake);
    expect(reg.get('ethereum')).toBe(fake);
    expect(reg.get('ethereum', 'mainnet')).toBeUndefined();
    expect(() => reg.require('ethereum', 'mainnet')).toThrow(/MAINNET/);
    const fakeMain = { chain: { network: 'ethereum', chainId: '1' } } as never;
    reg.register(fakeMain, 'mainnet');
    expect(reg.require('ethereum', 'mainnet')).toBe(fakeMain);
    expect(reg.require('ethereum')).toBe(fake); // testnet intacto
    expect(reg.mainnetNetworks()).toEqual(['ethereum']);
  });
});

describe('dual-ambiente — dealHash back-compat', () => {
  const baseTerms = (): Terms => ({
    schemaVersion: 1, environment: 'dev', dealId: 'OTC-x', revision: 1, createdAt: 1, expiresAt: 2,
    participants: [], requiredSignatures: 3, legs: [], pricing: {} as Terms['pricing'],
    route: { routeId: 'RT', kind: 'HTLC', legs: [] }, dealNonce: 'ab',
  });
  it('terms sem netEnv hasheiam idêntico ao formato antigo; mainnet muda o domainHash', () => {
    const t = baseTerms();
    const legacy = computeDealHash(t);
    const withTestnet = computeDealHash({ ...t, netEnv: 'testnet' });
    const withMainnet = computeDealHash({ ...t, netEnv: 'mainnet' });
    expect(withTestnet.domainHash).toBe(legacy.domainHash); // testnet explícito = mesmo domínio
    expect(withMainnet.domainHash).not.toBe(legacy.domainHash);
    expect(withMainnet.dealHash).not.toBe(legacy.dealHash);
  });
});

describe('dual-ambiente — getChain por env', () => {
  it("getChain('ethereum','mainnet') ignora o override CHAIN_ENDPOINT_*", () => {
    // O deploy real tem CHAIN_ENDPOINT_ETHEREUM apontando a Sepolia; a leitura mainnet fica limpa.
    const test = getChain('ethereum');
    const main = getChain('ethereum', 'mainnet');
    expect(main?.endpoint).toBe('https://ethereum-rpc.publicnode.com');
    expect(test?.endpoint).toBeTruthy();
    const mainBtc = getChain('bitcoin', 'mainnet');
    expect(mainBtc?.endpoint).toBe('https://blockstream.info/api');
  });
});

describe('dual-ambiente — regra de par da mesa MAINNET', () => {
  const fundedReaders = {
    native: async () => ({ amount: 50 }),
    tokens: async () => [{ symbol: 'USDT', contract: 'x', amount: 10_000_000 }],
    priceUsdOf: async () => 1_000,
  };
  it('mainnet aceita BTC↔ETH; rejeita BTC↔Tron e ETH↔ETH; testnet segue liberada', async () => {
    const { app } = await makeApp({ balanceReaders: fundedReaders, tronHashlock: true });
    const pm = await registerPm(app);
    const mk = (environment: string | undefined, chairs: unknown[]) =>
      app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(pm), payload: { ...(environment ? { environment } : {}), chairs } });

    const ok = await mk('mainnet', [{ role: 'SELLER', expectedAsset: BTC }, { role: 'BUYER', expectedAsset: ETH }, { role: 'PAYMASTER_1', expectedAsset: GAS_ETH }]);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ environment: string }>().environment).toBe('mainnet');

    const tron = await mk('mainnet', [{ role: 'SELLER', expectedAsset: BTC }, { role: 'BUYER', expectedAsset: USDT_TRON }, { role: 'PAYMASTER_1', expectedAsset: USDT_TRON }]);
    expect(tron.statusCode).toBe(400);
    expect(tron.json<{ message: string }>().message).toMatch(/MAINNET/);

    const ethEth = await mk('mainnet', [{ role: 'SELLER', expectedAsset: ETH }, { role: 'BUYER', expectedAsset: { ...ETH, symbol: 'WETH', contractOrMint: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' } }, { role: 'PAYMASTER_1', expectedAsset: GAS_ETH }]);
    expect(ethEth.statusCode).toBe(400);

    const testnetTron = await mk(undefined, [{ role: 'SELLER', expectedAsset: BTC }, { role: 'BUYER', expectedAsset: USDT_TRON }, { role: 'PAYMASTER_1', expectedAsset: USDT_TRON }]);
    expect(testnetTron.statusCode, testnetTron.body).toBe(201);
    expect(testnetTron.json<{ environment: string }>().environment).toBe('testnet');
    await app.close();
  }, 60_000);

  it('approve de mesa MAINNET sem adapters mainnet é fail-closed (nunca cai no simulador testnet)', async () => {
    const { app } = await makeApp({ balanceReaders: fundedReaders });
    const pm = await registerPm(app);
    const mesaRes = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(pm), payload: { environment: 'mainnet', chairs: [
      { role: 'SELLER', expectedAsset: BTC }, { role: 'BUYER', expectedAsset: ETH }, { role: 'PAYMASTER_1', expectedAsset: GAS_ETH },
    ] } });
    const { mesaId } = mesaRes.json<{ mesaId: string }>();
    const mesa = app.mesa.mesaById(mesaId)!;
    const seller = btcWallet(); const sellerEvm = evmWallet(); const buyer = evmWallet(); const pm1 = evmWallet();
    const chairOf = (role: string): MesaChair => mesa.chairs.find(c => c.role === role) as MesaChair;
    const multi = (primary: { network: string; address: string }, extra: { network: string; address: string }[]) =>
      ({ address: primary.address, network: primary.network, multichain: true, connectedAt: Date.now(), addresses: [primary, ...extra] });
    chairOf('SELLER').wallet = multi({ network: 'bitcoin', address: seller.address }, [{ network: 'ethereum', address: sellerEvm.address }]);
    chairOf('BUYER').wallet = multi({ network: 'ethereum', address: buyer.address }, [{ network: 'bitcoin', address: btcWallet().address }]);
    chairOf('PAYMASTER_1').wallet = multi({ network: 'ethereum', address: pm1.address }, []);
    mesa.chairs.forEach(c => { c.firstName = c.role; c.connectedAt = Date.now(); });
    await app.api.inject({ method: 'PATCH', url: `/v1/portal/mesas/${mesaId}/config`, headers: pmHeaders(pm), payload: { amountInBase: '20000000', buyerAmountInBase: '1000000000000000000', discountBps: 0, commissionBps: 0 } });
    const ap = await app.api.inject({ method: 'POST', url: `/v1/portal/mesas/${mesaId}/approve`, headers: pmHeaders(pm), payload: {} });
    expect(ap.statusCode, ap.body).toBeGreaterThanOrEqual(400); // sem grupos *_MAINNET_* não há adapter mainnet
    expect(ap.body).toMatch(/MAINNET/i);
    await app.close();
  }, 60_000);

  it('deal MAINNET roteia pelos adapters mainnet injetados — os de testnet nunca são tocados', async () => {
    const { app, clock } = await makeApp({ balanceReaders: fundedReaders });
    // Fakes mainnet = simuladores locais dedicados (injeção de teste); os de testnet ganham spies.
    const { createLocalAdapters } = await import('../src/adapters/local.js');
    void createLocalAdapters; // adapters locais do app já existem; criamos instâncias mainnet próprias
    const verifier = async () => true;
    const btcMain = new LocalChainAdapter('bitcoin', 'mainnet-sim', 'bc1qescrow', verifier as never, { finality: 1, nativeCode: 'BTC', htlc: true, escrowNN: false, verifiable: ['secp256k1'] });
    const evmMain = new LocalChainAdapter('ethereum', '1', '0x00000000000000000000000000000000000000AA', verifier as never, { finality: 1, nativeCode: 'ETH', htlc: false, escrowNN: true, verifiable: ['secp256k1'] });
    btcMain.now = clock.now; evmMain.now = clock.now; // mesmo relógio injetado do app
    app.adapters.register(btcMain, 'mainnet');
    app.adapters.register(evmMain, 'mainnet');
    app.registry.add({ code: 'ETH', network: 'ethereum', chainId: '1', contractOrMint: null, assetId: 'eip155:1/slip44:60', decimals: 18, tokenStandard: 'native', issuer: 'native', status: 'active' });
    app.registry.add({ code: 'BTC', network: 'bitcoin', chainId: 'mainnet-sim', contractOrMint: null, assetId: 'bip122:mainnet-sim/slip44:0', decimals: 8, tokenStandard: 'native', issuer: 'native', status: 'active' });
    app.sources.price.forEach(s => { s.setPrice('eip155:1/slip44:60', 2400); s.setPrice('bip122:mainnet-sim/slip44:0', 64000); });
    app.sources.liquidity.forEach(s => { const d = (s as unknown as { depths: Record<string, number> }).depths; d['eip155:1/slip44:60'] = 8_000_000; d['bip122:mainnet-sim/slip44:0'] = 8_000_000; });

    const testnetBtc = app.adapters.require('bitcoin');
    const spyTestnet = { called: 0 };
    const origRegister = testnetBtc.registerDeal.bind(testnetBtc);
    (testnetBtc as { registerDeal: typeof origRegister }).registerDeal = async c => { spyTestnet.called++; return origRegister(c); };

    const seller = btcWallet(); const buyer = evmWallet(); const pm1 = evmWallet();
    btcMain.mint(seller.address, null, 50_000_000n);
    evmMain.mint(buyer.address, null, 10n ** 19n);
    let deal = await app.deals.create({
      assetIn: { network: 'bitcoin', chainId: 'mainnet-sim', contractOrMint: null },
      assetOut: { network: 'ethereum', chainId: '1', contractOrMint: null },
      amountInBase: '20000000', discountBps: 0, maxSlippageBps: 50, maxPriceDriftBps: 500, expiresInSec: 2400,
      netEnv: 'mainnet',
      participants: [
        { role: 'SELLER', network: 'bitcoin', chainId: 'mainnet-sim', address: seller.address },
        { role: 'PAYMASTER_1', network: 'ethereum', chainId: '1', address: pm1.address },
        { role: 'BUYER', network: 'ethereum', chainId: '1', address: buyer.address },
      ],
    }, seller.address);
    for (const p of [{ role: 'PAYMASTER_1' as const, address: pm1.address }, { role: 'BUYER' as const, address: buyer.address }]) {
      deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address);
    }
    expect(deal.state).toBe('LIQUIDITY_VERIFIED');
    expect(deal.terms?.netEnv).toBe('mainnet');
    await app.deals.open(deal.id, seller.address);
    deal = await app.deals.get(deal.id);
    expect(deal.state).toBe('AWAITING_SIGNATURES');
    expect(deal.onChain.bitcoin?.registered).toBe(true);
    expect(spyTestnet.called).toBe(0); // o adapter TESTNET nunca foi tocado
    await app.close();
  }, 60_000);
});
