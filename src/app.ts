/**
 * Composition root — monta store, engines, adaptadores, API e scheduler. Em `dev`/teste usa os simuladores locais
 * (LocalChainAdapter) e fontes estáticas; nunca conecta a fundos reais. Adaptadores reais entram por injeção (`overrides`).
 */
import { MemoryStore } from './db/memoryStore.js';
import { SqlStore, createPgliteClient, createPgClient, type SqlClient } from './db/sqlStore.js';
import type { Store } from './db/repository.js';
import { AdapterRegistry, type ApprovalVerifier, type DealCommitment, type SettlementAdapter } from './adapters/types.js';
import { createLocalAdapters, LocalChainAdapter } from './adapters/local.js';
import { EvmChainAdapter, EvmDevKeyring } from './adapters/evm.js';
import { evmConfig, verumEvmConfig, solanaConfig, tronConfig } from './config.js';
import { VerumEvmAdapter } from './adapters/verum/evm.js';
import { VerumSolanaAdapter } from './adapters/verum/solana.js';
import { VerumTronAdapter } from './adapters/verum/tron.js';
import { VerumEvmDevKeyring, TronDevKeyring } from './adapters/verum/keyring.js';
import { AssetRegistry, defaultRegistry } from './engines/assetRegistry.js';
import { PriceEngine, StaticPriceSource, type PriceSource } from './engines/price.js';
import { LiquidityEngine, StaticLiquiditySource, type LiquiditySource } from './engines/liquidity.js';
import { RouterEngine } from './engines/router.js';
import { SignatureEngine, envelopeFor, verifyEvm, verifySolana, verifyBitcoin, verifyTron } from './engines/signature.js';
import { RiskEngine, DenylistScreening, type WalletScreening } from './engines/risk.js';
import { DealEngine } from './engines/deal.js';
import { SettlementEngine } from './engines/settlement.js';
import { AuditLog } from './audit/audit.js';
import { WalletAuth } from './wallet/auth.js';
import { PortalService } from './portal/portal.js';
import { DemoMesaKeyring, demoSecret } from './portal/demo.js';
import { PostgresPortalPersistence } from './portal/pgPortal.js';
import { FieldCrypto, deriveDevKeys } from './identity/crypto.js';
import { OtpManager, FakeEmailChannel, FakeSmsChannel, type OtpChannel } from './identity/otp.js';
import { InMemoryIdentityStore } from './identity/store.js';
import { IdentityService } from './identity/service.js';
import { RoomService, type SignatureVerifier } from './rooms/service.js';
import { ProposalService } from './proposals/service.js';
import { verifyMessage } from 'viem';
import { buildApi } from './api/server.js';
import { metrics, logger } from './monitoring/metrics.js';
import type { Config } from './config.js';
import type { Deal, Participant } from './domain/types.js';
import type { ApprovalSignature } from './adapters/types.js';

export interface AppOverrides { autoSettle?: boolean; store?: Store; adapters?: SettlementAdapter[]; priceSources?: PriceSource[]; liquiditySources?: LiquiditySource[]; screening?: WalletScreening; now?: () => number; denylist?: string[] }
export interface App { config: Config; store: Store; adapters: AdapterRegistry; local?: { evm: LocalChainAdapter; solana: LocalChainAdapter; bitcoin: LocalChainAdapter; tron?: LocalChainAdapter }; evm?: EvmChainAdapter; verumEvm?: VerumEvmAdapter; verumSolana?: VerumSolanaAdapter; verumTron?: VerumTronAdapter; registry: AssetRegistry; price: PriceEngine; liquidity: LiquidityEngine; router: RouterEngine; signature: SignatureEngine; risk: RiskEngine; audit: AuditLog; deals: DealEngine; settlement: SettlementEngine; auth: WalletAuth; identity: IdentityService; rooms: RoomService; proposals: ProposalService; api: Awaited<ReturnType<typeof buildApi>>; sources: { price: StaticPriceSource[]; liquidity: StaticLiquiditySource[] }; startScheduler(): void; stopScheduler(): void; close(): Promise<void> }

export const LOCAL_TOKENS = { usdtEth: '0x0000000000000000000000000000000000000001', usdcEth: '0x0000000000000000000000000000000000000002', usdtSol: 'USDT1111111111111111111111111111111111111111', usdcSol: 'USDC1111111111111111111111111111111111111111', usdtTron: 'TUsdtDemo1111111111111111111111111', btcTron: 'TBtcDemo11111111111111111111111111' };
export const LOCAL_CODE_HASHES = { usdtEth: 'codehash-usdt-v1', usdcEth: 'codehash-usdc-v1' };
export const LOCAL_PRICES: Record<string, number> = { 'bip122:regtest/slip44:0': 64_230.5, 'eip155:31337/slip44:60': 2_418.75, 'solana:localnet/slip44:501': 151.2, [`eip155:31337/erc20:${LOCAL_TOKENS.usdtEth}`]: 1.0002, [`eip155:31337/erc20:${LOCAL_TOKENS.usdcEth}`]: 0.9999, [`solana:localnet/token:${LOCAL_TOKENS.usdtSol}`]: 1.0001, [`solana:localnet/token:${LOCAL_TOKENS.usdcSol}`]: 1.0 };

export async function createApp(config: Config, o: AppOverrides = {}): Promise<App> {
  const now = o.now ?? (() => Date.now());
  let store: Store;
  // Cliente SQL compartilhado (deals + portal) quando em pglite/postgres. Em postgres (Supabase)
  // usamos a connection string do pooler; guardamos o cliente p/ o PortalService persistir junto.
  let sqlClient: SqlClient | undefined;
  if (o.store) { store = o.store; }
  else if (config.DATABASE_MODE === 'pglite') { sqlClient = await createPgliteClient(config.PGLITE_DIR); store = new SqlStore(sqlClient); }
  else if (config.DATABASE_MODE === 'postgres') { if (!config.DATABASE_URL) throw new Error('DATABASE_MODE=postgres exige DATABASE_URL'); sqlClient = await createPgClient(config.DATABASE_URL); store = new SqlStore(sqlClient); }
  else { store = new MemoryStore(); }
  await store.init();
  const audit = new AuditLog(store, now);
  const adapters = new AdapterRegistry();
  const escrowByChain = (network: string) => adapters.get(network as Participant['network'])?.escrowAddress() ?? '0x0000000000000000000000000000000000000000';
  /** O mesmo verificador criptográfico do Signature Engine é injetado nos simuladores (equivalência off-chain ↔ on-chain). */
  const verifier: ApprovalVerifier = async (dealHash, participant, sig: ApprovalSignature) => {
    // O simulador recomputa o hash; o verificador só valida a assinatura do envelope contra o participante.
    const deal = verifierDealRef.get(dealHash); if (!deal) return false;
    const env = envelopeFor(deal, participant.role, sig.nonce, config.OTC_ENV, escrowByChain);
    if (participant.network === 'ethereum') return verifyEvm(env, sig.signature, participant.address);
    if (participant.network === 'solana') return verifySolana(env.message, sig.signature, participant.address);
    if (participant.network === 'tron') return verifyTron(env.message, sig.signature, participant.address);
    return verifyBitcoin(env.message, sig.signature, participant.address);
  };
  const verifierDealRef = new Map<string, Deal>();
  let local: App['local'];
  // Modo EVM (contrato real na Sepolia/anvil): o adaptador ethereum real SUBSTITUI o simulador;
  // solana/bitcoin continuam locais. Keyring dev só fora de produção.
  // Escrow canônico Verum (contratos verum-otc-onchain): grupos por rede têm precedência sobre o
  // modo EVM_* legado. Deps stateless (serverless-safe): meta em deal.onChain + Deal do store.
  const verumEvmCfg = o.adapters ? null : verumEvmConfig(config);
  const solCfg = o.adapters ? null : solanaConfig(config);
  const tronCfg = o.adapters ? null : tronConfig(config);
  const evmCfg = o.adapters || verumEvmCfg ? null : evmConfig(config);
  const dealDeps = { getDeal: (id: string) => store.getDeal(id) };
  let demoKeyringRef: DemoMesaKeyring | null = null; // preenchido quando a conta demo é semeada (assina txs Solana dev)
  let evmAdapter: EvmChainAdapter | undefined; let evmKeyring: EvmDevKeyring | undefined;
  let verumEvm: VerumEvmAdapter | undefined; let verumEvmKeyring: VerumEvmDevKeyring | undefined;
  let verumSolana: VerumSolanaAdapter | undefined; let verumTron: VerumTronAdapter | undefined; let tronKeyring: TronDevKeyring | undefined;
  if (o.adapters) o.adapters.forEach(a => adapters.register(a));
  else { local = createLocalAdapters(verifier, now); adapters.register(local.evm).register(local.solana).register(local.bitcoin);
    local.evm.addToken({ contract: LOCAL_TOKENS.usdtEth, symbol: 'USDT', decimals: 6, standard: 'ERC-20', codeHash: LOCAL_CODE_HASHES.usdtEth }).addToken({ contract: LOCAL_TOKENS.usdcEth, symbol: 'USDC', decimals: 6, standard: 'ERC-20', codeHash: LOCAL_CODE_HASHES.usdcEth });
    local.solana.addToken({ contract: LOCAL_TOKENS.usdtSol, symbol: 'USDT', decimals: 6, standard: 'SPL', codeHash: 'spl', mintAuthority: null }).addToken({ contract: LOCAL_TOKENS.usdcSol, symbol: 'USDC', decimals: 6, standard: 'SPL', codeHash: 'spl', mintAuthority: null });
    // Tron agora é rede de liquidação: simulador local sempre registrado (fallback sem TRON_*).
    const tronLocal = new LocalChainAdapter('tron', 'nile', 'TVerumEscrowDemo111111111111111111', verifier, { finality: 19, nativeCode: 'TRX', htlc: false, escrowNN: true, verifiable: ['secp256k1'] });
    tronLocal.now = now;
    tronLocal.addToken({ contract: LOCAL_TOKENS.usdtTron, symbol: 'USDT', decimals: 6, standard: 'TRC-20', codeHash: 'trc20-usdt' }).addToken({ contract: LOCAL_TOKENS.btcTron, symbol: 'tBTC', decimals: 8, standard: 'TRC-20', codeHash: 'trc20-tbtc' });
    local.tron = tronLocal; adapters.register(tronLocal);
    if (evmCfg) { evmKeyring = config.OTC_ENV === 'prod' ? undefined : new EvmDevKeyring(config.identityMasterSecret); evmAdapter = new EvmChainAdapter(evmCfg, evmKeyring ?? null); adapters.register(evmAdapter); logger.info({ chainId: evmCfg.chainId, escrow: evmCfg.escrow }, 'modo EVM ativo: liquidação via VerumOtcEscrow real (legado)'); }
    if (verumEvmCfg) {
      verumEvmKeyring = config.OTC_ENV === 'prod' ? undefined : new VerumEvmDevKeyring(config.identityMasterSecret);
      verumEvm = new VerumEvmAdapter(verumEvmCfg, verumEvmKeyring ?? null, dealDeps); adapters.register(verumEvm);
      logger.info({ chainId: verumEvmCfg.chainId, escrow: verumEvmCfg.escrow }, 'modo VERUM_EVM ativo: escrow canônico VerumOTCEscrowEVM');
    }
    if (solCfg) {
      verumSolana = new VerumSolanaAdapter(solCfg, addr => demoKeyringRef?.secretKeyByAddress(addr) ?? null, dealDeps); adapters.register(verumSolana);
      logger.info({ cluster: solCfg.chainId, programId: solCfg.programId }, 'modo SOLANA ativo: programa verum_otc real');
    }
    if (tronCfg) {
      tronKeyring = config.OTC_ENV === 'prod' ? undefined : new TronDevKeyring(config.identityMasterSecret);
      verumTron = new VerumTronAdapter(tronCfg, tronKeyring ?? null, dealDeps); adapters.register(verumTron);
      logger.info({ chainId: tronCfg.chainId, escrow: tronCfg.escrow }, 'modo TRON ativo: escrow VerumOTCEscrowTron real');
    }
  }
  const tokens = verumEvmCfg ? { ...LOCAL_TOKENS, usdtEth: verumEvmCfg.tusdt } : evmCfg ? { ...LOCAL_TOKENS, usdtEth: evmCfg.tusdt } : LOCAL_TOKENS;
  const registry = defaultRegistry({ ethereum: adapters.require('ethereum').chain.chainId, solana: adapters.require('solana').chain.chainId, bitcoin: adapters.require('bitcoin').chain.chainId }, tokens, LOCAL_CODE_HASHES, { usdtSol: null, usdcSol: null });
  if (evmCfg) registry.add({ code: 'BTC', network: 'ethereum', chainId: evmCfg.chainId, contractOrMint: evmCfg.tbtc, assetId: `eip155:${evmCfg.chainId}/erc20:${evmCfg.tbtc.toLowerCase()}`, decimals: 8, tokenStandard: 'ERC-20', issuer: 'Verum tBTC (mock)', status: 'active' });
  if (verumEvmCfg) registry.add({ code: 'BTC', network: 'ethereum', chainId: String(verumEvmCfg.chainId), contractOrMint: verumEvmCfg.tbtc, assetId: `eip155:${verumEvmCfg.chainId}/erc20:${verumEvmCfg.tbtc.toLowerCase()}`, decimals: 8, tokenStandard: 'ERC-20', issuer: 'Verum tBTC (mock)', status: 'active' });
  // Ativos TRC-20 (simulado ou Nile real) — um deal Tron↔Tron usa USDT e tBTC na mesma rede.
  const tronChainId = adapters.require('tron').chain.chainId;
  const tronUsdt = tronCfg ? tronCfg.tusdt : LOCAL_TOKENS.usdtTron;
  const tronTbtc = tronCfg ? tronCfg.tbtc : LOCAL_TOKENS.btcTron;
  registry.add({ code: 'USDT', network: 'tron', chainId: tronChainId, contractOrMint: tronUsdt, assetId: `tron:${tronChainId}/trc20:${tronUsdt}`, decimals: 6, tokenStandard: 'TRC-20', issuer: tronCfg ? 'USDT (Nile faucet)' : 'Tether (demo)', status: 'active' });
  registry.add({ code: 'BTC', network: 'tron', chainId: tronChainId, contractOrMint: tronTbtc, assetId: `tron:${tronChainId}/trc20:${tronTbtc}`, decimals: 8, tokenStandard: 'TRC-20', issuer: 'Verum tBTC (mock)', status: 'active' });
  // Mints Solana reais (devnet) quando o modo SOLANA está ativo.
  if (solCfg) {
    const solChainId = adapters.require('solana').chain.chainId;
    registry.add({ code: 'USDT', network: 'solana', chainId: solChainId, contractOrMint: solCfg.tusdtMint, assetId: `solana:${solChainId}/token:${solCfg.tusdtMint}`, decimals: 6, tokenStandard: 'SPL', issuer: 'Verum tUSDT (devnet)', status: 'active' });
    registry.add({ code: 'BTC', network: 'solana', chainId: solChainId, contractOrMint: solCfg.tbtcMint, assetId: `solana:${solChainId}/token:${solCfg.tbtcMint}`, decimals: 8, tokenStandard: 'SPL', issuer: 'Verum tBTC (devnet)', status: 'active' });
  }
  // Preços/profundidade dev: assetIds reais das testnets entram na fonte estática.
  const prices: Record<string, number> = { ...LOCAL_PRICES };
  if (evmCfg) { prices[`eip155:${evmCfg.chainId}/erc20:${evmCfg.tbtc.toLowerCase()}`] = 64_230.5; prices[`eip155:${evmCfg.chainId}/erc20:${evmCfg.tusdt.toLowerCase()}`] = 1.0002; prices[`eip155:${evmCfg.chainId}/slip44:60`] = 2_418.75; }
  if (verumEvmCfg) { prices[`eip155:${verumEvmCfg.chainId}/erc20:${verumEvmCfg.tbtc.toLowerCase()}`] = 64_230.5; prices[`eip155:${verumEvmCfg.chainId}/erc20:${verumEvmCfg.tusdt.toLowerCase()}`] = 1.0002; prices[`eip155:${verumEvmCfg.chainId}/slip44:60`] = 2_418.75; }
  prices[`tron:${tronChainId}/trc20:${tronUsdt}`] = 1.0001; prices[`tron:${tronChainId}/trc20:${tronTbtc}`] = 64_230.5;
  if (solCfg) { const solChainId = adapters.require('solana').chain.chainId; prices[`solana:${solChainId}/token:${solCfg.tusdtMint}`] = 1.0001; prices[`solana:${solChainId}/token:${solCfg.tbtcMint}`] = 64_230.5; }
  const depth: Record<string, number> = Object.fromEntries(Object.keys(prices).map(k => [k, 8_000_000]));
  const priceSources = (o.priceSources as StaticPriceSource[] | undefined) ?? [new StaticPriceSource('Pyth', 1.0, prices), new StaticPriceSource('Chainlink', 1.0, prices), new StaticPriceSource('Coinbase', 0.8, prices), new StaticPriceSource('Kraken', 0.8, prices)];
  const liquiditySources = (o.liquiditySources as StaticLiquiditySource[] | undefined) ?? [new StaticLiquiditySource('Binance', 1.0, depth), new StaticLiquiditySource('Coinbase', 0.9, depth), new StaticLiquiditySource('Jupiter', 0.7, depth)];
  const price = new PriceEngine(priceSources, undefined, now); const liquidity = new LiquidityEngine(liquiditySources, undefined, now);
  const router = new RouterEngine(adapters); const signature = new SignatureEngine(store, config.OTC_ENV, escrowByChain, now);
  const risk = new RiskEngine(store, o.screening ?? new DenylistScreening(new Set(o.denylist ?? [])), { maxDealUsd: config.MAX_DEAL_USD, maxWalletDailyUsd: config.MAX_DEAL_USD * 5, maxOpenDealsPerWallet: 10 }, now);
  const deals = new DealEngine({ store, registry, adapters, price, liquidity, router, signature, risk, audit, now, config: { env: config.OTC_ENV, platformFeeBps: config.PLATFORM_FEE_BPS, paymasterShareBps: config.PAYMASTER_SHARE_BPS, treasury: config.TREASURY_ADDRESS, networkCostUsd: async n => adapters.require(n).estimateCostUsd('settle'), execMarginMs: config.EXEC_MARGIN_MS, defaultExpiresSec: 3600 } });
  // o simulador precisa do envelope para verificar: registra a Deal por hash quando os termos congelam
  // mapa limitado: só Deals com termos congelados e não terminais (sem vazamento de memória em runs longos)
  deals.events.on('deal', (ev: { dealId: string; type: string; state: string }) => { void (async () => { const d = await store.getDeal(ev.dealId); if (!d?.hash) return; if (['SETTLED', 'REFUNDED', 'CANCELLED', 'BLOCKED', 'EXPIRED'].includes(ev.state)) verifierDealRef.delete(d.hash.dealHash); else verifierDealRef.set(d.hash.dealHash, d); if (verifierDealRef.size > 10_000) verifierDealRef.delete(verifierDealRef.keys().next().value as string); })(); });
  const settlement = new SettlementEngine({ store, adapters, price, router, risk, signature, registry, audit, now, execMarginMs: config.EXEC_MARGIN_MS }, deals.mutator());
  if (o.autoSettle !== false) deals.events.on('settle', (id: string) => { void settlement.settle(id, 'keeper').catch(e => logger.warn({ dealId: id, code: (e as { code?: string }).code, err: (e as Error).message }, 'liquidação automática rejeitada')); });
  // Serverless (Vercel): o estado do SIMULADOR on-chain é por instância — uma deal criada noutra
  // instância não existe no simulador desta. Antes de liquidar, re-registra e re-deposita aqui
  // (idempotente; só roda quando o adapter reporta NONE). Também alimenta o verificador local.
  const ensureOnChain = async (dealId: string): Promise<void> => {
    if (!local) return;
    const deal = await store.getDeal(dealId); const t = deal?.terms; const h = deal?.hash;
    if (!deal || !t || !h) return;
    verifierDealRef.set(h.dealHash, deal);
    const c: DealCommitment = { dealId: deal.id, revision: deal.revision, dealHash: h.dealHash, expiresAt: t.expiresAt, participants: t.participants, legs: t.legs, pricingHash: h.pricingHash, routeHash: h.routeHash, domainHash: h.domainHash, dealNonce: t.dealNonce, feeBps: t.pricing.platformFeeBps, treasury: config.TREASURY_ADDRESS, htlcHash: t.route.htlcHash, terms: t };
    for (const chain of new Set(t.legs.map(l => l.escrowChain))) {
      const a = adapters.require(chain);
      if (!(a instanceof LocalChainAdapter)) continue; // adapters reais são stateless vs RPC — nada a re-hidratar
      const st = await a.getDealState(deal.id);
      if (st.status !== 'NONE') continue;
      await a.registerDeal(c);
      const sim = chain === 'solana' ? local.solana : chain === 'bitcoin' ? local.bitcoin : chain === 'tron' ? (local.tron ?? local.evm) : local.evm;
      for (const leg of t.legs.filter(l => l.escrowChain === chain)) {
        const p = deal.participants.find(x => x.role === leg.from); if (!p || p.funding !== 'FINAL') continue;
        sim.mint(p.address, leg.asset.contractOrMint, BigInt(leg.amountBase));
        await a.deposit(deal.id, leg.index, p.address);
      }
    }
  };
  const auth = new WalletAuth(store, adapters, { env: config.OTC_ENV, sessionSecret: config.sessionSecret, sessionTtlMs: config.SESSION_TTL_MS, challengeTtlMs: 5 * 60_000, operators: config.operators, appDomain: config.APP_DOMAIN }, now);
  // Persistência do portal: postgres/Supabase quando há cliente SQL (sessão sobrevive ao serverless);
  // senão arquivo local (dev). Hidrata o estado inicial antes de servir requisições.
  const portalPersistence = sqlClient ? new PostgresPortalPersistence(sqlClient, now) : undefined;
  const portal = new PortalService({ file: config.PORTAL_DATA_FILE, sessionTtlMs: 24 * 3600_000, now, persistence: portalPersistence });
  if (portalPersistence) await portal.hydrate();
  // Conta DEMO (apresentações): mesa 4/4 com carteiras falsas do keyring; nunca em produção.
  let demo: { keyring: DemoMesaKeyring; addresses: Set<string> } | undefined;
  if (config.OTC_ENV !== 'prod') {
    const kr = new DemoMesaKeyring(demoSecret(config.DEMO_EMAIL, config.DEMO_PASSWORD));
    demoKeyringRef = kr; // o adapter Solana real (devnet) assina as txs dos papéis demo com estas keypairs
    const wallets = Object.fromEntries((['PAYMASTER_1', 'SELLER', 'BUYER', 'PAYMASTER_2'] as const).map(r => [r, { address: kr.addressFor(r), addresses: kr.addressesFor(r) }]));
    portal.seedDemo({ email: config.DEMO_EMAIL, password: config.DEMO_PASSWORD, wallets: wallets as Parameters<PortalService['seedDemo']>[0]['wallets'] });
    demo = { keyring: kr, addresses: kr.allAddresses() };
    logger.info({ email: config.DEMO_EMAIL }, 'conta demo da mesa semeada');
  }
  // Identidade mínima (§2). Canais de OTP: fakes locais em dev/teste; adaptadores reais (SES/SNS/Twilio)
  // entram por injeção em produção. O `devOutbox` só é exposto quando OTC_ENV=dev.
  const identityCrypto = new FieldCrypto(deriveDevKeys(config.identityMasterSecret));
  const emailChannel: OtpChannel = new FakeEmailChannel();
  const smsChannel: OtpChannel = new FakeSmsChannel();
  const identity = new IdentityService({
    store: new InMemoryIdentityStore(), crypto: identityCrypto, now, audit,
    emailOtp: new OtpManager(identityCrypto, emailChannel, now),
    phoneOtp: new OtpManager(identityCrypto, smsChannel, now),
    config: { reverifyDays: config.CONTACT_REVERIFY_DAYS, allowedCallingCodes: config.SMS_ALLOWED_CALLING_CODES.split(',').map(s => s.trim()).filter(Boolean), smsDailyCap: config.SMS_DAILY_CAP, walletRecoveryGraceMs: config.WALLET_RECOVERY_GRACE_MS },
  });
  const identityDev = config.OTC_ENV === 'dev' ? { email: emailChannel as FakeEmailChannel, sms: smsChannel as FakeSmsChannel } : undefined;
  // Salas de operação (§5). Verificador de assinatura de ingresso por rede; notificações content-free.
  const verifyRoomSig: SignatureVerifier = async (network, message, signature, address) => {
    if (network === 'ethereum') { try { return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` }); } catch { return false; } }
    if (network === 'solana') return verifySolana(message, signature, address);
    return verifyBitcoin(message, signature, address);
  };
  const rooms = new RoomService({
    identity, verifySignature: verifyRoomSig, now, audit,
    notifier: { notify: (_userId, roomId) => logger.info({ roomId }, RoomService.notificationText(roomId)) },
    config: { appDomain: config.APP_DOMAIN, allowedOrigins: config.OTC_ENV === 'prod' ? [`https://${config.APP_DOMAIN}`] : [] },
  });
  // Propostas estruturadas de alteração de termos (§5.3/§6) — porta de entrada tipada para o amend.
  const proposals = new ProposalService({ deals, now, audit, notifier: { notify: dealId => logger.info({ dealId }, 'atualização de proposta de termos') } });
  const api = await buildApi({ deals, settlement, price, liquidity, router, registry, platformFeeBps: config.PLATFORM_FEE_BPS, networkCostUsd: async n => adapters.require(n).estimateCostUsd('settle'), auth, portal, identity, identityDev, rooms, proposals, store, audit, mesaHtmlPath: config.MESA_HTML_PATH, portalHtmlPath: config.PORTAL_HTML_PATH, conviteHtmlPath: config.CONVITE_HTML_PATH, env: config.OTC_ENV, rateLimit: { windowMs: 60_000, max: config.OTC_ENV === 'dev' ? 100_000 : 120 }, dev: local ? { solanaChainId: local.solana.chain.chainId, mint: (a, c, amt) => local!.solana.mint(a, c, amt), demo, ensureOnChain, evm: verumEvm && verumEvmKeyring && verumEvmCfg ? { chainId: String(verumEvmCfg.chainId), escrow: verumEvmCfg.escrow, tbtc: verumEvmCfg.tbtc, tusdt: verumEvmCfg.tusdt, explorerBase: verumEvmCfg.explorerBase, keyring: verumEvmKeyring, mintToken: (t, to, amt) => verumEvm!.mintToken(t, to, amt) } : evmAdapter && evmKeyring && evmCfg ? { chainId: evmCfg.chainId, escrow: evmCfg.escrow, tbtc: evmCfg.tbtc, tusdt: evmCfg.tusdt, explorerBase: evmCfg.explorerBase, keyring: evmKeyring, mintToken: (t, to, amt) => evmAdapter!.mintToken(t, to, amt) } : undefined } : undefined });
  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  const tick = async () => { try { const ids = await deals.expireDue(); if (ids.length) logger.info({ ids }, 'deals expiradas'); if (++ticks % 720 === 0) { const purged = await store.purge(now(), 24 * 3600_000); logger.info(purged, 'retenção'); } metrics.priceBreakerOpen.set(price.breakerState().open ? 1 : 0); for (const s of ['AWAITING_SIGNATURES', 'SETTLING', 'SETTLEMENT_VALIDATION', 'REFUNDING'] as const) metrics.activeDeals.set({ state: s }, (await store.listDeals({ states: [s] })).length); } catch (e) { logger.error({ err: (e as Error).message }, 'scheduler'); } };
  return { config, store, adapters, local, evm: evmAdapter, verumEvm, verumSolana, verumTron, registry, price, liquidity, router, signature, risk, audit, deals, settlement, auth, identity, rooms, proposals, api, sources: { price: priceSources, liquidity: liquiditySources },
    startScheduler() { if (!timer) timer = setInterval(() => { void tick(); }, config.EXPIRY_SCAN_MS); }, stopScheduler() { if (timer) clearInterval(timer); timer = null; },
    async close() { if (timer) clearInterval(timer); timer = null; await api.close(); await store.close(); } };
}
