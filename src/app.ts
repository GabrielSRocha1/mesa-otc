/**
 * Composition root — monta store, engines, adaptadores, API e scheduler. Em `dev`/teste usa os simuladores locais
 * (LocalChainAdapter) e fontes estáticas; nunca conecta a fundos reais. Adaptadores reais entram por injeção (`overrides`).
 */
import { MemoryStore } from './db/memoryStore.js';
import { SqlStore, createPgliteClient, createPgClient, type SqlClient } from './db/sqlStore.js';
import type { Store } from './db/repository.js';
import { AdapterRegistry, type ApprovalVerifier, type DealCommitment, type SettlementAdapter } from './adapters/types.js';
import { createLocalAdapters, LocalChainAdapter } from './adapters/local.js';
import { createLightningService } from './adapters/lightning/index.js';
import { LightningLegAdapter } from './adapters/lightning/legAdapter.js';
import { verumEvmConfig, solanaConfig, tronConfig, bitcoinConfig } from './config.js';
import { BitcoinChainAdapter } from './adapters/bitcoin.js';
import { VerumEvmAdapter } from './adapters/verum/evm.js';
import { VerumEvmV2Adapter } from './adapters/verum/evmV2.js';
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
import { CHALLENGE_TTL_MS } from './domain/constants.js';
import { MesaService } from './mesa/mesaService.js';
import { PushService, vapidFrom } from './mesa/push.js';
import { metrics, logger } from './monitoring/metrics.js';
import type { Config } from './config.js';
import type { Deal, Network, Participant, Role } from './domain/types.js';
import type { ApprovalSignature } from './adapters/types.js';

export interface AppOverrides { autoSettle?: boolean; store?: Store; adapters?: SettlementAdapter[]; priceSources?: PriceSource[]; liquiditySources?: LiquiditySource[]; screening?: WalletScreening; now?: () => number; denylist?: string[]; balanceReaders?: import('./mesa/balances.js').BalanceReaders; btcAddressOf?: (dealId: string, role: Role) => Promise<string | null>; evmAddressOf?: (dealId: string, role: Role) => Promise<string | null>; /** Runner de swap resumível (testnet): preimage HTLC fixa p/ recriar a deal com o mesmo htlcHash de um lock confirmado. */ htlcPreimageHex?: string; /** Nó Lightning injetado (rota LIGHTNING_SWAP) — mock in-process nos testes; senão vem de createLightningService. */ lightning?: import('./adapters/lightning/types.js').LightningService }
export interface App { config: Config; store: Store; adapters: AdapterRegistry; local?: { evm: LocalChainAdapter; solana: LocalChainAdapter; bitcoin: LocalChainAdapter; tron?: LocalChainAdapter }; verumEvm?: VerumEvmAdapter; verumSolana?: VerumSolanaAdapter; verumTron?: VerumTronAdapter; verumEvmKeyring?: VerumEvmDevKeyring; tronKeyring?: TronDevKeyring; registry: AssetRegistry; price: PriceEngine; liquidity: LiquidityEngine; router: RouterEngine; signature: SignatureEngine; risk: RiskEngine; audit: AuditLog; deals: DealEngine; settlement: SettlementEngine; auth: WalletAuth; identity: IdentityService; rooms: RoomService; proposals: ProposalService; mesa: import('./mesa/mesaService.js').MesaService; lightning: import('./adapters/lightning/types.js').LightningService; lightningReal: boolean; api: Awaited<ReturnType<typeof buildApi>>; sources: { price: StaticPriceSource[]; liquidity: StaticLiquiditySource[] }; startScheduler(): void; stopScheduler(): void; close(): Promise<void> }

/** Mint canônico do Wrapped SOL (mesmo em todos os clusters) — SOL como token SPL. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** WETH canônico na Sepolia (ETH embrulhado como ERC-20). */
export const WETH_SEPOLIA = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
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
  const dealDeps = { getDeal: (id: string) => store.getDeal(id) };
  let portalRef: PortalService | null = null; // preenchido quando o portal sobe (resolvedor BTC multichain)
  let demoKeyringRef: DemoMesaKeyring | null = null; // preenchido quando a conta demo é semeada (assina txs Solana dev)
  let verumEvm: VerumEvmAdapter | undefined; let verumEvmV2: VerumEvmV2Adapter | undefined; let verumEvmKeyring: VerumEvmDevKeyring | undefined;
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
    if (verumEvmCfg) {
      verumEvmKeyring = config.OTC_ENV === 'prod' ? undefined : new VerumEvmDevKeyring(config.identityMasterSecret);
      if (verumEvmCfg.escrowV2) {
        // Escrow V2 (ADR-v4): cadeiras 2–4 + perna HTLC — substitui o V1 na rede EVM.
        // Vendedor de BTC nativo (participante na rede bitcoin) precisa de endereço EVM para
        // RECEBER o token do comprador: resolve pela carteira multichain da cadeira da mesa.
        const evmAddressOf = o.evmAddressOf ?? (async (dealId: string, role: Role) => {
          for (const m of Object.values(portalRef?.mesas() ?? {})) {
            if (m.dealId !== dealId && !(m.dealIds ?? []).includes(dealId)) continue;
            const w = m.chairs.find(c => c.role === role)?.wallet;
            if (!w) return null;
            return (w.addresses ?? []).find(a => /^0x[0-9a-fA-F]{40}$/.test(a.address))?.address ?? (/^0x[0-9a-fA-F]{40}$/.test(w.address) ? w.address : null);
          }
          return null;
        });
        verumEvmV2 = new VerumEvmV2Adapter(verumEvmCfg, verumEvmKeyring ?? null, { ...dealDeps, evmAddressOf }); adapters.register(verumEvmV2);
        logger.info({ chainId: verumEvmCfg.chainId, escrowV2: verumEvmCfg.escrowV2 }, 'modo VERUM_EVM_V2 ativo: escrow VerumOTCEscrowV2EVM (2–4 cadeiras + HTLC)');
      } else {
        verumEvm = new VerumEvmAdapter(verumEvmCfg, verumEvmKeyring ?? null, dealDeps); adapters.register(verumEvm);
        logger.info({ chainId: verumEvmCfg.chainId, escrow: verumEvmCfg.escrow }, 'modo VERUM_EVM ativo: escrow canônico VerumOTCEscrowEVM');
      }
    }
    if (solCfg) {
      // Perna HTLC cross-chain: o papel que RECEBE o token do lock (ex.: comprador em rede EVM)
      // precisa de endereço Solana — resolve pela carteira multichain da cadeira da mesa.
      const solAddressOf = async (dealId: string, role: Role) => {
        for (const m of Object.values(portalRef?.mesas() ?? {})) {
          if (m.dealId !== dealId && !(m.dealIds ?? []).includes(dealId)) continue;
          const w = m.chairs.find(c => c.role === role)?.wallet;
          if (!w) return null;
          return (w.addresses ?? []).find(a => a.network === 'solana')?.address ?? (w.network === 'solana' ? w.address : null);
        }
        return null;
      };
      verumSolana = new VerumSolanaAdapter(solCfg, addr => demoKeyringRef?.secretKeyByAddress(addr) ?? null, { ...dealDeps, solAddressOf }); adapters.register(verumSolana);
      logger.info({ cluster: solCfg.chainId, programId: solCfg.programId }, 'modo SOLANA ativo: programa verum_otc real (escrow N-de-N + perna HTLC)');
    }
    if (tronCfg) {
      tronKeyring = config.OTC_ENV === 'prod' ? undefined : new TronDevKeyring(config.identityMasterSecret);
      verumTron = new VerumTronAdapter(tronCfg, tronKeyring ?? null, dealDeps); adapters.register(verumTron);
      logger.info({ chainId: tronCfg.chainId, escrow: tronCfg.escrow }, 'modo TRON ativo: escrow VerumOTCEscrowTron real');
    }
    // Bitcoin REAL (HTLC P2WSH via Esplora): substitui o simulador regtest quando BITCOIN_* está completo.
    const btcCfg = bitcoinConfig(config);
    if (btcCfg) {
      // Payout BTC de papel sem carteira bitcoin NA DEAL (ex.: comprador conectado via Solana):
      // resolve pelo endereço multichain da Verum Wallet conectada à cadeira da mesa (late binding
      // — o portal sobe depois dos adapters).
      const btcAddressOf = o.btcAddressOf ?? (async (dealId: string, role: Role) => {
        for (const m of Object.values(portalRef?.mesas() ?? {})) {
          if (m.dealId !== dealId && !(m.dealIds ?? []).includes(dealId)) continue;
          const w = m.chairs.find(c => c.role === role)?.wallet;
          if (!w) return null;
          return (w.addresses ?? []).find(a => a.network === 'bitcoin')?.address ?? (w.network === 'bitcoin' ? w.address : null);
        }
        return null;
      });
      const btcReal = new BitcoinChainAdapter(btcCfg, { ...dealDeps, btcAddressOf });
      btcReal.now = now;
      adapters.register(btcReal);
      logger.info({ network: btcCfg.network, esplora: btcCfg.esploraUrl, csvBlocks: btcCfg.csvBlocks }, 'modo BITCOIN ativo: HTLC P2WSH real na rede Bitcoin');
    }
  }
  const tokens = verumEvmCfg ? { ...LOCAL_TOKENS, usdtEth: verumEvmCfg.tusdt } : LOCAL_TOKENS;
  const registry = defaultRegistry({ ethereum: adapters.require('ethereum').chain.chainId, solana: adapters.require('solana').chain.chainId, bitcoin: adapters.require('bitcoin').chain.chainId }, tokens, LOCAL_CODE_HASHES, { usdtSol: null, usdcSol: null });
  // BTC via Lightning (rota LIGHTNING_SWAP) — ativo nativo da "rede" lightning; entrega pelo nó LN.
  registry.add({ code: 'BTC', network: 'lightning', chainId: 'ln', contractOrMint: null, assetId: 'lightning:ln/btc', decimals: 8, tokenStandard: 'native', issuer: 'Lightning Network', status: 'active' });
  if (verumEvmCfg) registry.add({ code: 'BTC', network: 'ethereum', chainId: String(verumEvmCfg.chainId), contractOrMint: verumEvmCfg.tbtc, assetId: `eip155:${verumEvmCfg.chainId}/erc20:${verumEvmCfg.tbtc.toLowerCase()}`, decimals: 8, tokenStandard: 'ERC-20', issuer: 'Verum tBTC (mock)', status: 'active' });
  // WETH (ETH embrulhado) na rede EVM: habilita "vender ETH" como token via ESCROW_DIRECT. Diferente da
  // Solana, o escrow EVM TEM allowlist on-chain — o WETH precisa ser ativado via addToken (keeper owner).
  // A carteira embrulha ETH→WETH (deposit) e desembrulha (withdraw) na ponta.
  if (verumEvmCfg) registry.add({ code: 'WETH', network: 'ethereum', chainId: String(verumEvmCfg.chainId), contractOrMint: WETH_SEPOLIA, assetId: `eip155:${verumEvmCfg.chainId}/erc20:${WETH_SEPOLIA.toLowerCase()}`, decimals: 18, tokenStandard: 'ERC-20', issuer: 'Wrapped ETH (nativo embrulhado)', status: 'active' });
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
    // wSOL (SOL embrulhado): o programa Solana NÃO tem allowlist (aceita qualquer SPL válido), então
    // basta registrar no backend — habilita "vender SOL" como token (wSOL) via ESCROW_DIRECT na Solana.
    // A carteira embrulha SOL→wSOL antes de depositar e desembrulha na ponta.
    registry.add({ code: 'wSOL', network: 'solana', chainId: solChainId, contractOrMint: WSOL_MINT, assetId: `solana:${solChainId}/token:${WSOL_MINT}`, decimals: 9, tokenStandard: 'SPL', issuer: 'Wrapped SOL (nativo embrulhado)', status: 'active' });
  }
  // Preços/profundidade dev: assetIds reais das testnets entram na fonte estática.
  const prices: Record<string, number> = { ...LOCAL_PRICES };
  if (verumEvmCfg) { prices[`eip155:${verumEvmCfg.chainId}/erc20:${verumEvmCfg.tbtc.toLowerCase()}`] = 64_230.5; prices[`eip155:${verumEvmCfg.chainId}/erc20:${verumEvmCfg.tusdt.toLowerCase()}`] = 1.0002; prices[`eip155:${verumEvmCfg.chainId}/slip44:60`] = 2_418.75; prices[`eip155:${verumEvmCfg.chainId}/erc20:${WETH_SEPOLIA.toLowerCase()}`] = 2_418.75; }
  prices[`tron:${tronChainId}/trc20:${tronUsdt}`] = 1.0001; prices[`tron:${tronChainId}/trc20:${tronTbtc}`] = 64_230.5;
  // BTC nativo na chainId REAL do adapter (testnet/mainnet via BITCOIN_*; o regtest já está em LOCAL_PRICES).
  prices[`bip122:${adapters.require('bitcoin').chain.chainId}/slip44:0`] = 64_230.5;
  prices['lightning:ln/btc'] = 64_230.5; // BTC via Lightning — mesmo preço do BTC nativo
  if (solCfg) { const solChainId = adapters.require('solana').chain.chainId; prices[`solana:${solChainId}/token:${solCfg.tusdtMint}`] = 1.0001; prices[`solana:${solChainId}/token:${solCfg.tbtcMint}`] = 64_230.5; prices[`solana:${solChainId}/token:${WSOL_MINT}`] = 151.2; prices[`solana:${solChainId}/slip44:501`] = 151.2; }
  const depth: Record<string, number> = Object.fromEntries(Object.keys(prices).map(k => [k, 8_000_000]));
  const priceSources = (o.priceSources as StaticPriceSource[] | undefined) ?? [new StaticPriceSource('Pyth', 1.0, prices), new StaticPriceSource('Chainlink', 1.0, prices), new StaticPriceSource('Coinbase', 0.8, prices), new StaticPriceSource('Kraken', 0.8, prices)];
  const liquiditySources = (o.liquiditySources as StaticLiquiditySource[] | undefined) ?? [new StaticLiquiditySource('Binance', 1.0, depth), new StaticLiquiditySource('Coinbase', 0.9, depth), new StaticLiquiditySource('Jupiter', 0.7, depth)];
  const price = new PriceEngine(priceSources, undefined, now); const liquidity = new LiquidityEngine(liquiditySources, undefined, now);
  const router = new RouterEngine(adapters); const signature = new SignatureEngine(store, config.OTC_ENV, escrowByChain, now);
  const risk = new RiskEngine(store, o.screening ?? new DenylistScreening(new Set(o.denylist ?? [])), { maxDealUsd: config.MAX_DEAL_USD, maxWalletDailyUsd: config.MAX_DEAL_USD * 5, maxOpenDealsPerWallet: 10 }, now);
  // Hook mutável "é sua vez" (Web Push): o DealEngine é criado ANTES de portal/mesa/push, então o
  // callback real é atribuído depois (ver notifyTurn abaixo). Best-effort, nunca lança.
  let notifyTurn: (dealId: string, role: string) => void = () => {};
  const deals = new DealEngine({ store, registry, adapters, price, liquidity, router, signature, risk, audit, now, config: { env: config.OTC_ENV, platformFeeBps: config.PLATFORM_FEE_BPS, paymasterShareBps: config.PAYMASTER_SHARE_BPS, treasury: config.TREASURY_ADDRESS, networkCostUsd: async n => adapters.require(n).estimateCostUsd('settle'), execMarginMs: config.EXEC_MARGIN_MS, defaultExpiresSec: 3600, onTurnChange: (deal) => { if (deal.turnRole) notifyTurn(deal.id, deal.turnRole); }, ...(o.htlcPreimageHex ? { htlcPreimageHex: o.htlcPreimageHex } : {}) } });
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
      if (st.status === 'NONE') await a.registerDeal(c);
      for (const leg of t.legs.filter(l => l.escrowChain === chain)) {
        const p = deal.participants.find(x => x.role === leg.from); if (!p) continue;
        // Saldo do depositante É por instância no simulador: semeia SEMPRE (amount + folga p/
        // comissões) — cobre tanto o re-depósito dos FINAL quanto o depósito VIVO de uma carteira
        // real numa perna simulada (preview BITCOIN_SIMULATE), que chega zerada em toda instância.
        a.mint(p.address, leg.asset.contractOrMint, BigInt(leg.amountBase) * 2n);
        if (p.funding !== 'FINAL') continue;
        try { await a.deposit(deal.id, leg.index, p.address); } catch { /* idempotente/expirada — melhor esforço */ }
      }
    }
  };
  const auth = new WalletAuth(store, adapters, { env: config.OTC_ENV, sessionSecret: config.sessionSecret, sessionTtlMs: config.SESSION_TTL_MS, challengeTtlMs: CHALLENGE_TTL_MS, operators: config.operators, appDomain: config.APP_DOMAIN }, now);
  // Persistência do portal: postgres/Supabase quando há cliente SQL (sessão sobrevive ao serverless);
  // senão arquivo local (dev). Hidrata o estado inicial antes de servir requisições.
  const portalPersistence = sqlClient ? new PostgresPortalPersistence(sqlClient, now) : undefined;
  const portal = new PortalService({ file: config.PORTAL_DATA_FILE, sessionTtlMs: 24 * 3600_000, now, persistence: portalPersistence });
  portalRef = portal;
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
  // Mesas multi-instância (v3): cadeiras + convites por cadeira + prova de posse na conexão.
  // Embrulho canônico por rede. SOL agora fica NATIVO em TODAS as rotas Solana — o escrow N-de-N
  // ganhou perna nativa (seller_sign_sol/buyer_sign_sol: lamports no PDA; settle/refund nativos) e
  // o HTLC cross-chain já era nativo. ETH→WETH continua (contrato EVM é só-token em qualquer rota);
  // BTC fica de fora (HTLC nativo próprio).
  const nativeWrapOf = (network: string, _counterpartyNetwork: string | null): { contractOrMint: string; decimals: number } | null => {
    if (network === 'ethereum' && verumEvmCfg?.escrowV2) return { contractOrMint: WETH_SEPOLIA, decimals: 18 };
    return null;
  };
  const mesa = new MesaService({ portal, store, audit, auth, getDeal: id => store.getDeal(id), baseUrl: `https://${config.APP_DOMAIN}`, now, nativeWrapOf, btcSimulated: () => adapters.get('bitcoin') instanceof LocalChainAdapter });
  // Web Push "é sua vez": serviço (gracioso se VAPID ausente) + hook real do DealEngine. Procura a
  // mesa do deal, acha a cadeira do papel da vez e dispara a notificação para a inscrição dela.
  // Lightning (rota LIGHTNING_SWAP): nó real quando o grupo LND_* está completo; senão o simulador
  // in-process. Injetável nos testes via AppOverrides.lightning. Fica disponível no App; inerte até
  // uma operação Lightning ser criada (o fluxo HTLC on-chain não é afetado).
  const ln = createLightningService(config);
  const lightning = o.lightning ?? ln.service;
  const lightningReal = o.lightning ? false : ln.real;
  // A perna BTC da rota LIGHTNING_SWAP entra no registry como a "rede" lightning (LightningLegAdapter);
  // o motor a trata uniformemente. Inerte até uma deal lightning existir. getDeal resolve a invoice.
  adapters.register(new LightningLegAdapter(lightning, { getDeal: id => store.getDeal(id), now }));
  const push = new PushService(vapidFrom(config), logger);
  notifyTurn = (dealId, role) => {
    try {
      const m = Object.values(portal.mesas()).find(x => x.dealId === dealId);
      const chair = m?.chairs.find(c => c.role === role);
      if (!m || !chair?.pushSub) return;
      void push.send(chair.pushSub, { title: 'É a sua vez de assinar', body: `Mesa ${m.code}: toque para abrir e assinar na Verum Wallet.`, url: `https://${config.APP_DOMAIN}/mesa?mesa=${m.mesaId}`, tag: `turn:${m.mesaId}` });
    } catch { /* best-effort */ }
  };
  // FRENTE D (auditoria 2026-10-20): quando os turnos são ADIADOS por registro pendente do contrato
  // (turn.deferred, turnRole=null — o onTurnChange acima não dispara nada nesse caso), avisa quem
  // registra (PAYMASTER_1, msg.sender do createTradeV2) para abrir a aba e confirmar o registro —
  // senão a operação fica parada esperando alguém tocar a tela. Best-effort; inerte sem VAPID/push.
  const notifyRegister = (dealId: string) => {
    try {
      const m = Object.values(portal.mesas()).find(x => x.dealId === dealId);
      const chair = m?.chairs.find(c => c.role === 'PAYMASTER_1');
      if (!m || !chair?.pushSub) return;
      void push.send(chair.pushSub, { title: 'Registre o contrato', body: `Mesa ${m.code}: abra e confirme o registro do contrato para liberar as assinaturas.`, url: `https://${config.APP_DOMAIN}/mesa?mesa=${m.mesaId}`, tag: `register:${m.mesaId}` });
    } catch { /* best-effort */ }
  };
  deals.events.on('deal', (ev: { dealId: string; type: string }) => { if (ev.type === 'turn.deferred') notifyRegister(ev.dealId); });
  // Ativação de token na allowlist on-chain do escrow V2 (ex.: WETH) — só quando o V2 está ativo.
  const escrowAddToken = verumEvmV2 ? ((t: `0x${string}`, d: number, s: string) => verumEvmV2!.addToken(t, d, s)) : undefined;
  const api = await buildApi({ deals, settlement, price, liquidity, router, registry, adapters, platformFeeBps: config.PLATFORM_FEE_BPS, mesa, lightning, push, escrowAddToken, networkCostUsd: async n => adapters.require(n).estimateCostUsd('settle'), auth, portal, identity, identityDev, rooms, proposals, store, audit, balanceReaders: o.balanceReaders, mesaHtmlPath: config.MESA_HTML_PATH, portalHtmlPath: config.PORTAL_HTML_PATH, conviteHtmlPath: config.CONVITE_HTML_PATH, operacaoHtmlPath: config.OPERACAO_HTML_PATH, env: config.OTC_ENV, demoDeferFunding: config.DEMO_DEFER_FUNDING, rateLimit: { windowMs: 60_000, max: config.OTC_ENV === 'dev' ? 100_000 : 120 }, dev: local ? { solanaChainId: adapters.require('solana').chain.chainId, mint: (a, c, amt) => local!.solana.mint(a, c, amt), demo, ensureOnChain, seed: (network, address, contract, amount) => { const a = adapters.get(network as Network); if (a instanceof LocalChainAdapter) a.mint(address, contract, amount); }, evm: verumEvm && verumEvmKeyring && verumEvmCfg ? { chainId: String(verumEvmCfg.chainId), escrow: verumEvmCfg.escrow, tbtc: verumEvmCfg.tbtc, tusdt: verumEvmCfg.tusdt, explorerBase: verumEvmCfg.explorerBase, keyring: verumEvmKeyring, mintToken: (t, to, amt) => verumEvm!.mintToken(t, to, amt) } : undefined } : undefined });
  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  const tick = async () => { try { const ids = await deals.expireDue(); if (ids.length) logger.info({ ids }, 'deals expiradas');
    // REEMBOLSO AUTOMÁTICO (auditoria 2026-10-19): deals em REFUNDING com legs PENDING são
    // retentadas pelo keeper — é assim que o refund BTC pós-CSV (~48h) sai SOZINHO quando o
    // timelock vence, sem operador rodar script. Espaçado (~2 min) p/ não spammar RPC/Esplora.
    if (ticks % 24 === 0) { for (const d of await store.listDeals({ states: ['REFUNDING'] })) { if (!d.refunds.some(r => r.status === 'PENDING')) continue; try { await deals.retryRefunds(d.id); } catch (e) { logger.warn({ dealId: d.id, err: (e as Error).message }, 'retryRefunds agendado falhou'); } } }
    // FRENTE C (auditoria 2026-10-20): deal em LIQUIDITY_VERIFIED com perna HTLC cujo lock BTC JÁ
    // confirmou on-chain abre SOZINHA — sem depender de alguém tocar o endpoint de depósito. O open()
    // detecta o lock (registra o cofre sem tx + lê o Esplora) e segue; se ainda não confirmou, lança
    // FUNDING_REQUIRED e tentamos no próximo ciclo. Espaçado p/ não martelar o Esplora.
    if (ticks % 4 === 0) { for (const d of await store.listDeals({ states: ['LIQUIDITY_VERIFIED'] })) { if (!d.terms?.legs.some(l => l.mode === 'HTLC')) continue; try { await deals.open(d.id, d.createdBy); logger.info({ dealId: d.id }, 'auto-open: lock BTC confirmado'); } catch { /* lock ainda não confirmou — próximo ciclo */ } } }
    if (++ticks % 720 === 0) { const purged = await store.purge(now(), 24 * 3600_000); logger.info(purged, 'retenção'); } metrics.priceBreakerOpen.set(price.breakerState().open ? 1 : 0); for (const s of ['AWAITING_SIGNATURES', 'SETTLING', 'SETTLEMENT_VALIDATION', 'REFUNDING'] as const) metrics.activeDeals.set({ state: s }, (await store.listDeals({ states: [s] })).length); } catch (e) { logger.error({ err: (e as Error).message }, 'scheduler'); } };
  return { config, store, adapters, local, verumEvm, verumSolana, verumTron, verumEvmKeyring, tronKeyring, registry, price, liquidity, router, signature, risk, audit, deals, settlement, auth, identity, rooms, proposals, mesa, lightning, lightningReal, api, sources: { price: priceSources, liquidity: liquiditySources },
    startScheduler() { if (!timer) timer = setInterval(() => { void tick(); }, config.EXPIRY_SCAN_MS); }, stopScheduler() { if (timer) clearInterval(timer); timer = null; },
    async close() { if (timer) clearInterval(timer); timer = null; await api.close(); await store.close(); } };
}
