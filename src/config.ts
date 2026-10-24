/** Configuração por ambiente (zod). Sem segredos no código: em dev/teste um segredo de sessão efêmero é gerado. */
import { z } from 'zod';
import { randomBytes } from 'node:crypto';

const Schema = z.object({
  OTC_ENV: z.enum(['dev', 'testnet', 'staging', 'prod']).default('dev'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_MODE: z.enum(['memory', 'pglite', 'postgres']).default('memory'),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_TTL_MS: z.coerce.number().default(10 * 60_000),
  OPERATOR_ADDRESSES: z.string().default(''),
  TREASURY_ADDRESS: z.string().default('0x000000000000000000000000000000000000dEaD'),
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(500).default(3), // 3 bps = 0,03% = 0.0003 (fee = volume * 0.0003)
  PAYMASTER_SHARE_BPS: z.coerce.number().int().min(0).max(500).default(0),
  EXEC_MARGIN_MS: z.coerce.number().default(60_000),
  MAX_DEAL_USD: z.coerce.number().default(100_000),
  EXPIRY_SCAN_MS: z.coerce.number().default(5_000),
  APP_DOMAIN: z.string().default('otc.verumcrypto.com'),
  MESA_HTML_PATH: z.string().optional(),
  PORTAL_HTML_PATH: z.string().optional(),
  CONVITE_HTML_PATH: z.string().optional(),
  OPERACAO_HTML_PATH: z.string().optional(),
  PORTAL_DATA_FILE: z.string().default('./.data/portal.json'),
  BLOCKCHAIR_API_KEY: z.string().optional(), // chave Blockchair p/ leitura de saldo Zcash
  // Identidade mínima (§2/§8/§10). O segredo mestre deriva as chaves de cifragem/índice/OTP.
  IDENTITY_MASTER_SECRET: z.string().min(32).optional(), // hex; obrigatório em prod
  CONTACT_REVERIFY_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  SMS_ALLOWED_CALLING_CODES: z.string().default('1,33,34,39,44,49,351,52,54,55,56,57,595,598'),
  SMS_DAILY_CAP: z.coerce.number().int().min(1).default(1000),
  WALLET_RECOVERY_GRACE_MS: z.coerce.number().int().min(60_000).default(72 * 3600_000),
  // ---- Escrow canônico Verum (contratos verum-otc-onchain) — grupos all-or-nothing por rede ----
  // EVM (VerumOTCEscrowEVM em anvil/Sepolia).
  VERUM_EVM_RPC_URL: z.string().optional(),
  VERUM_EVM_CHAIN_ID: z.string().optional(),
  VERUM_EVM_ESCROW_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  VERUM_EVM_KEEPER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  VERUM_EVM_ATTESTOR_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  VERUM_EVM_TBTC: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  VERUM_EVM_TUSDT: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  VERUM_EVM_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(1),
  VERUM_EVM_EXPLORER_BASE: z.string().optional(),
  // Escrow V2 (ADR-v4: cadeiras 2–4 + htlcHash). Definido → o adapter V2 SUBSTITUI o V1 na rede EVM.
  VERUM_EVM_V2_ESCROW_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // Solana (programa verum_otc em devnet/localnet). Keypairs = JSON array de 64 bytes.
  SOLANA_RPC_URL: z.string().optional(),
  SOLANA_CHAIN_ID: z.enum(['101', '102', '103']).optional(),
  SOLANA_PROGRAM_ID: z.string().optional(),
  SOLANA_EXECUTOR_KEYPAIR: z.string().optional(),
  SOLANA_ATTESTOR_KEYPAIR: z.string().optional(),
  SOLANA_TUSDT_MINT: z.string().optional(),
  SOLANA_TBTC_MINT: z.string().optional(),
  SOLANA_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(1),
  // Tron (VerumOTCEscrowTron na Nile). CHAIN_ID decimal (nile = 3448148188).
  TRON_FULL_HOST: z.string().optional(),
  TRON_CHAIN_ID: z.string().optional(),
  TRON_ESCROW_ADDRESS: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/).optional(),
  TRON_EXECUTOR_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).optional(),
  TRON_ATTESTOR_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).optional(),
  TRON_TUSDT: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/).optional(),
  TRON_TBTC: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/).optional(),
  TRON_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(19),
  // Bitcoin nativo (HTLC P2WSH real via Esplora — blockstream/mempool/regtest local).
  // Força o SIMULADOR de Bitcoin mesmo com o grupo BITCOIN_* completo — preview/teste do fluxo
  // de usuário com blocos instantâneos sem mexer nas envs reais herdadas da produção.
  BITCOIN_SIMULATE: z.enum(['0', '1']).default('0'),
  BITCOIN_ESPLORA_URL: z.string().optional(),
  BITCOIN_NETWORK: z.enum(['mainnet', 'testnet', 'signet', 'regtest']).optional(),
  BITCOIN_CLAIM_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).optional(),
  BITCOIN_REFUND_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).optional(),
  BITCOIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(12).default(3),
  // Timelock CSV do refund BTC. SEM valor explícito, o default é DERIVADO DA REDE (ver bitcoinConfig):
  // mainnet 48 (~8h), signet/testnet 36 (~6h), regtest 144 (local). Definir aqui SOBRESCREVE o default.
  // Trade-off: o CSV precisa ficar acima da janela do token (40 min) + claim + variância/reorg —
  // encurtar demais arrisca a atomicidade do swap (contraparte honesta perde a janela de claim).
  BITCOIN_CSV_BLOCKS: z.coerce.number().int().min(6).max(1000).optional(),
  BITCOIN_FEE_FLOOR_SAT_VB: z.coerce.number().int().min(1).max(500).default(2),
  // Lightning Network (rota LIGHTNING_SWAP — perna BTC via LND REST). Grupo all-or-nothing:
  // LND_REST_URL + LND_MACAROON (hex, escopo mínimo invoice+offchain+readonly) + LND_TLS_CERT (PEM
  // ou base64). Ausente = rota Lightning desligada (o HTLC on-chain segue como único caminho BTC).
  // LND_SIMULATE=1 força o simulador in-process (preview/teste) mesmo com o grupo real presente.
  LND_SIMULATE: z.enum(['0', '1']).default('0'),
  LND_REST_URL: z.string().optional(),
  LND_MACAROON: z.string().regex(/^[0-9a-fA-F]+$/).optional(),      // macaroon em hex
  LND_TLS_CERT: z.string().optional(),                              // PEM ou base64 do cert do nó
  LND_INVOICE_EXPIRY_SEC: z.coerce.number().int().min(60).max(3600).default(600), // expiry curto (~10 min)
  LND_PAYMENT_TIMEOUT_SEC: z.coerce.number().int().min(5).max(300).default(60),   // teto do pagamento LN
  // Conta DEMO do portal (apresentações): semeada no boot fora de produção.
  DEMO_EMAIL: z.string().default('demo@verumotc.com'),
  DEMO_PASSWORD: z.string().min(8).default('VerumDemo2026'),
  // Demo: adia o financiamento do escrow para a 1ª assinatura (em vez de financiar ao criar o deal).
  // Assim a mesa aprovada fica "não irreversível" e o botão "Reabrir para editar" aparece no demo.
  DEMO_DEFER_FUNDING: z.coerce.boolean().default(false),
  // ---- Operar Indexado (preço indexado ao Verum Swap) — grupo all-or-nothing ----
  // Endpoint SERVER-SIDE do motor de swap da Verum (POST {URL}/api/swap/quote) + chave. Ausente em prod
  // ⇒ modo indexado DESLIGADO (fail-closed, nunca simula preço em produção). Em dev/testnet sem URL, um
  // MockIndexProvider in-process é usado (preço de dev; nunca em prod).
  VERUM_SWAP_ENGINE_URL: z.string().optional(),
  VERUM_SWAP_ENGINE_KEY: z.string().optional(),
  VERUM_SWAP_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(3_000),
  VERUM_SWAP_MIN_PROVIDERS: z.coerce.number().int().min(1).max(20).default(2),
  VERUM_SWAP_MAX_DISPERSION_BPS: z.coerce.number().int().min(1).max(5_000).default(100),
  VERUM_SWAP_SPREAD_BPS_MIN: z.coerce.number().int().min(-5_000).max(0).default(-500),
  VERUM_SWAP_SPREAD_BPS_MAX: z.coerce.number().int().min(0).max(5_000).default(500),
  VERUM_SWAP_MAX_MOVE_BPS: z.coerce.number().int().min(1).max(5_000).default(100),
  VERUM_SWAP_FIXING_TTL_SEC: z.coerce.number().int().min(60).max(3_600).default(600),
  // Web Push (notificação "é sua vez de assinar"). Sem as chaves → push simplesmente desligado
  // (degradação graciosa). Gere com `npx web-push generate-vapid-keys`.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:suporte@verumcrypto.com'),
  LOG_LEVEL: z.string().default('info')
});
export type Config = z.infer<typeof Schema> & { sessionSecret: string; operators: Set<string>; identityMasterSecret: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Variáveis de ambiente VAZIAS ("") são tratadas como NÃO-definidas — assim os defaults do
  // schema valem (ex.: OTC_ENV="" na Vercel não quebra mais o boot; cai em 'dev').
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const c = Schema.parse(clean);
  if (c.OTC_ENV === 'prod') {
    if (!c.SESSION_SECRET) throw new Error('SESSION_SECRET é obrigatório em produção');
    if (c.DATABASE_MODE !== 'postgres' || !c.DATABASE_URL) throw new Error('Produção exige DATABASE_MODE=postgres e DATABASE_URL');
    if (!c.IDENTITY_MASTER_SECRET) throw new Error('IDENTITY_MASTER_SECRET é obrigatório em produção');
  }
  const sessionSecret = c.SESSION_SECRET ?? randomBytes(48).toString('hex');
  // Em dev/teste, deriva um segredo mestre efêmero de 32 bytes (nunca no código).
  const identityMasterSecret = c.IDENTITY_MASTER_SECRET ?? randomBytes(32).toString('hex');
  // Grupos do escrow canônico Verum: ou completos, ou vazios (meia-configuração = erro de boot).
  const groups: [string, (string | undefined)[]][] = [
    ['VERUM_EVM', [c.VERUM_EVM_RPC_URL, c.VERUM_EVM_CHAIN_ID, c.VERUM_EVM_ESCROW_ADDRESS, c.VERUM_EVM_KEEPER_KEY, c.VERUM_EVM_ATTESTOR_KEY, c.VERUM_EVM_TBTC, c.VERUM_EVM_TUSDT]],
    ['SOLANA', [c.SOLANA_RPC_URL, c.SOLANA_CHAIN_ID, c.SOLANA_PROGRAM_ID, c.SOLANA_EXECUTOR_KEYPAIR, c.SOLANA_ATTESTOR_KEYPAIR, c.SOLANA_TUSDT_MINT, c.SOLANA_TBTC_MINT]],
    ['TRON', [c.TRON_FULL_HOST, c.TRON_CHAIN_ID, c.TRON_ESCROW_ADDRESS, c.TRON_EXECUTOR_KEY, c.TRON_ATTESTOR_KEY, c.TRON_TUSDT, c.TRON_TBTC]],
    ['BITCOIN', [c.BITCOIN_ESPLORA_URL, c.BITCOIN_NETWORK, c.BITCOIN_CLAIM_KEY, c.BITCOIN_REFUND_KEY]],
    ['LND', [c.LND_REST_URL, c.LND_MACAROON, c.LND_TLS_CERT]],
    ['VERUM_SWAP_ENGINE', [c.VERUM_SWAP_ENGINE_URL, c.VERUM_SWAP_ENGINE_KEY]],
  ];
  for (const [name, keys] of groups) {
    const set = keys.filter(Boolean).length;
    if (set > 0 && set < keys.length) throw new Error(`Modo ${name} exige o grupo de envs ${name}_* COMPLETO (${set}/${keys.length} definidas)`);
  }
  return { ...c, sessionSecret, identityMasterSecret, operators: new Set(c.OPERATOR_ADDRESSES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) };
}

/** Escrow canônico Verum — EVM. null = grupo ausente (modo simulado). */
export interface VerumEvmSettings { rpcUrl: string; chainId: number; escrow: `0x${string}`; escrowV2: `0x${string}` | null; keeperKey: `0x${string}`; attestorKey: `0x${string}`; tbtc: `0x${string}`; tusdt: `0x${string}`; confirmations: number; explorerBase: string | null }
export function verumEvmConfig(c: Config): VerumEvmSettings | null {
  if (!c.VERUM_EVM_RPC_URL || !c.VERUM_EVM_CHAIN_ID || !c.VERUM_EVM_ESCROW_ADDRESS || !c.VERUM_EVM_KEEPER_KEY || !c.VERUM_EVM_ATTESTOR_KEY || !c.VERUM_EVM_TBTC || !c.VERUM_EVM_TUSDT) return null;
  return { rpcUrl: c.VERUM_EVM_RPC_URL, chainId: Number(c.VERUM_EVM_CHAIN_ID), escrow: c.VERUM_EVM_ESCROW_ADDRESS as `0x${string}`, escrowV2: (c.VERUM_EVM_V2_ESCROW_ADDRESS as `0x${string}` | undefined) ?? null, keeperKey: c.VERUM_EVM_KEEPER_KEY as `0x${string}`, attestorKey: c.VERUM_EVM_ATTESTOR_KEY as `0x${string}`, tbtc: c.VERUM_EVM_TBTC as `0x${string}`, tusdt: c.VERUM_EVM_TUSDT as `0x${string}`, confirmations: c.VERUM_EVM_CONFIRMATIONS, explorerBase: c.VERUM_EVM_EXPLORER_BASE?.replace(/\/$/, '') ?? null };
}

/** Escrow canônico Verum — Solana (programa verum_otc). null = grupo ausente. */
export interface SolanaSettings { rpcUrl: string; chainId: '101' | '102' | '103'; programId: string; executorKeypair: string; attestorKeypair: string; tusdtMint: string; tbtcMint: string; confirmations: number }
export function solanaConfig(c: Config): SolanaSettings | null {
  if (!c.SOLANA_RPC_URL || !c.SOLANA_CHAIN_ID || !c.SOLANA_PROGRAM_ID || !c.SOLANA_EXECUTOR_KEYPAIR || !c.SOLANA_ATTESTOR_KEYPAIR || !c.SOLANA_TUSDT_MINT || !c.SOLANA_TBTC_MINT) return null;
  return { rpcUrl: c.SOLANA_RPC_URL, chainId: c.SOLANA_CHAIN_ID, programId: c.SOLANA_PROGRAM_ID, executorKeypair: c.SOLANA_EXECUTOR_KEYPAIR, attestorKeypair: c.SOLANA_ATTESTOR_KEYPAIR, tusdtMint: c.SOLANA_TUSDT_MINT, tbtcMint: c.SOLANA_TBTC_MINT, confirmations: c.SOLANA_CONFIRMATIONS };
}

/** Lightning Network (LND REST). null = grupo ausente OU LND_SIMULATE=1 (simulador in-process). */
export interface LndSettings { restUrl: string; macaroonHex: string; tlsCert: string; invoiceExpirySec: number; paymentTimeoutSec: number }
export function lndConfig(c: Config): LndSettings | null {
  if (c.LND_SIMULATE === '1') return null;
  if (!c.LND_REST_URL || !c.LND_MACAROON || !c.LND_TLS_CERT) return null;
  return { restUrl: c.LND_REST_URL.replace(/\/$/, ''), macaroonHex: c.LND_MACAROON, tlsCert: c.LND_TLS_CERT, invoiceExpirySec: c.LND_INVOICE_EXPIRY_SEC, paymentTimeoutSec: c.LND_PAYMENT_TIMEOUT_SEC };
}

/** Bitcoin nativo (HTLC P2WSH real). null = grupo ausente (simulador regtest local). */
export interface BitcoinSettingsCfg { esploraUrl: string; network: 'mainnet' | 'testnet' | 'signet' | 'regtest'; claimKey: string; refundKey: string; confirmations: number; csvBlocks: number; feeFloorSatVb: number }
export function bitcoinConfig(c: Config): BitcoinSettingsCfg | null {
  if (c.BITCOIN_SIMULATE === '1') return null;
  if (!c.BITCOIN_ESPLORA_URL || !c.BITCOIN_NETWORK || !c.BITCOIN_CLAIM_KEY || !c.BITCOIN_REFUND_KEY) return null;
  // Default do CSV por rede (quando BITCOIN_CSV_BLOCKS não é definido): mainnet ~8h, signet/testnet ~6h.
  // regtest fica em 144 (blocos minerados na hora nos testes locais; não é deploy real).
  const csvDefaultByNetwork: Record<typeof c.BITCOIN_NETWORK & string, number> = { mainnet: 48, signet: 36, testnet: 36, regtest: 144 };
  const csvBlocks = c.BITCOIN_CSV_BLOCKS ?? csvDefaultByNetwork[c.BITCOIN_NETWORK];
  return { esploraUrl: c.BITCOIN_ESPLORA_URL, network: c.BITCOIN_NETWORK, claimKey: c.BITCOIN_CLAIM_KEY, refundKey: c.BITCOIN_REFUND_KEY, confirmations: c.BITCOIN_CONFIRMATIONS, csvBlocks, feeFloorSatVb: c.BITCOIN_FEE_FLOOR_SAT_VB };
}

/** Operar Indexado — motor de swap da Verum. null = grupo ausente (modo indexado desligado / mock em dev). */
export interface VerumSwapSettings { baseUrl: string; apiKey: string; timeoutMs: number; minProviders: number; maxDispersionBps: number }
export function verumSwapEngineConfig(c: Config): VerumSwapSettings | null {
  if (!c.VERUM_SWAP_ENGINE_URL || !c.VERUM_SWAP_ENGINE_KEY) return null;
  return { baseUrl: c.VERUM_SWAP_ENGINE_URL.replace(/\/$/, ''), apiKey: c.VERUM_SWAP_ENGINE_KEY, timeoutMs: c.VERUM_SWAP_TIMEOUT_MS, minProviders: c.VERUM_SWAP_MIN_PROVIDERS, maxDispersionBps: c.VERUM_SWAP_MAX_DISPERSION_BPS };
}

/** Escrow canônico Verum — Tron (Nile). null = grupo ausente. */
export interface TronSettings { fullHost: string; chainId: number; escrow: string; executorKey: string; attestorKey: `0x${string}`; tusdt: string; tbtc: string; confirmations: number }
export function tronConfig(c: Config): TronSettings | null {
  if (!c.TRON_FULL_HOST || !c.TRON_CHAIN_ID || !c.TRON_ESCROW_ADDRESS || !c.TRON_EXECUTOR_KEY || !c.TRON_ATTESTOR_KEY || !c.TRON_TUSDT || !c.TRON_TBTC) return null;
  const hex = (k: string) => (k.startsWith('0x') ? k : '0x' + k) as `0x${string}`;
  return { fullHost: c.TRON_FULL_HOST, chainId: Number(c.TRON_CHAIN_ID), escrow: c.TRON_ESCROW_ADDRESS, executorKey: c.TRON_EXECUTOR_KEY.replace(/^0x/, ''), attestorKey: hex(c.TRON_ATTESTOR_KEY), tusdt: c.TRON_TUSDT, tbtc: c.TRON_TBTC, confirmations: c.TRON_CONFIRMATIONS };
}

