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
  BITCOIN_ESPLORA_URL: z.string().optional(),
  BITCOIN_NETWORK: z.enum(['mainnet', 'testnet', 'regtest']).optional(),
  BITCOIN_CLAIM_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).optional(),
  BITCOIN_REFUND_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).optional(),
  BITCOIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(12).default(3),
  BITCOIN_CSV_BLOCKS: z.coerce.number().int().min(6).max(1000).default(144),
  BITCOIN_FEE_FLOOR_SAT_VB: z.coerce.number().int().min(1).max(500).default(2),
  // Conta DEMO do portal (apresentações): semeada no boot fora de produção.
  DEMO_EMAIL: z.string().default('demo@verumotc.com'),
  DEMO_PASSWORD: z.string().min(8).default('VerumDemo2026'),
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
  ];
  for (const [name, keys] of groups) {
    const set = keys.filter(Boolean).length;
    if (set > 0 && set < keys.length) throw new Error(`Modo ${name} exige o grupo de envs ${name}_* COMPLETO (${set}/${keys.length} definidas)`);
  }
  return { ...c, sessionSecret, identityMasterSecret, operators: new Set(c.OPERATOR_ADDRESSES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) };
}

/** Escrow canônico Verum — EVM. null = grupo ausente (modo simulado). */
export interface VerumEvmSettings { rpcUrl: string; chainId: number; escrow: `0x${string}`; keeperKey: `0x${string}`; attestorKey: `0x${string}`; tbtc: `0x${string}`; tusdt: `0x${string}`; confirmations: number; explorerBase: string | null }
export function verumEvmConfig(c: Config): VerumEvmSettings | null {
  if (!c.VERUM_EVM_RPC_URL || !c.VERUM_EVM_CHAIN_ID || !c.VERUM_EVM_ESCROW_ADDRESS || !c.VERUM_EVM_KEEPER_KEY || !c.VERUM_EVM_ATTESTOR_KEY || !c.VERUM_EVM_TBTC || !c.VERUM_EVM_TUSDT) return null;
  return { rpcUrl: c.VERUM_EVM_RPC_URL, chainId: Number(c.VERUM_EVM_CHAIN_ID), escrow: c.VERUM_EVM_ESCROW_ADDRESS as `0x${string}`, keeperKey: c.VERUM_EVM_KEEPER_KEY as `0x${string}`, attestorKey: c.VERUM_EVM_ATTESTOR_KEY as `0x${string}`, tbtc: c.VERUM_EVM_TBTC as `0x${string}`, tusdt: c.VERUM_EVM_TUSDT as `0x${string}`, confirmations: c.VERUM_EVM_CONFIRMATIONS, explorerBase: c.VERUM_EVM_EXPLORER_BASE?.replace(/\/$/, '') ?? null };
}

/** Escrow canônico Verum — Solana (programa verum_otc). null = grupo ausente. */
export interface SolanaSettings { rpcUrl: string; chainId: '101' | '102' | '103'; programId: string; executorKeypair: string; attestorKeypair: string; tusdtMint: string; tbtcMint: string; confirmations: number }
export function solanaConfig(c: Config): SolanaSettings | null {
  if (!c.SOLANA_RPC_URL || !c.SOLANA_CHAIN_ID || !c.SOLANA_PROGRAM_ID || !c.SOLANA_EXECUTOR_KEYPAIR || !c.SOLANA_ATTESTOR_KEYPAIR || !c.SOLANA_TUSDT_MINT || !c.SOLANA_TBTC_MINT) return null;
  return { rpcUrl: c.SOLANA_RPC_URL, chainId: c.SOLANA_CHAIN_ID, programId: c.SOLANA_PROGRAM_ID, executorKeypair: c.SOLANA_EXECUTOR_KEYPAIR, attestorKeypair: c.SOLANA_ATTESTOR_KEYPAIR, tusdtMint: c.SOLANA_TUSDT_MINT, tbtcMint: c.SOLANA_TBTC_MINT, confirmations: c.SOLANA_CONFIRMATIONS };
}

/** Bitcoin nativo (HTLC P2WSH real). null = grupo ausente (simulador regtest local). */
export interface BitcoinSettingsCfg { esploraUrl: string; network: 'mainnet' | 'testnet' | 'regtest'; claimKey: string; refundKey: string; confirmations: number; csvBlocks: number; feeFloorSatVb: number }
export function bitcoinConfig(c: Config): BitcoinSettingsCfg | null {
  if (!c.BITCOIN_ESPLORA_URL || !c.BITCOIN_NETWORK || !c.BITCOIN_CLAIM_KEY || !c.BITCOIN_REFUND_KEY) return null;
  return { esploraUrl: c.BITCOIN_ESPLORA_URL, network: c.BITCOIN_NETWORK, claimKey: c.BITCOIN_CLAIM_KEY, refundKey: c.BITCOIN_REFUND_KEY, confirmations: c.BITCOIN_CONFIRMATIONS, csvBlocks: c.BITCOIN_CSV_BLOCKS, feeFloorSatVb: c.BITCOIN_FEE_FLOOR_SAT_VB };
}

/** Escrow canônico Verum — Tron (Nile). null = grupo ausente. */
export interface TronSettings { fullHost: string; chainId: number; escrow: string; executorKey: string; attestorKey: `0x${string}`; tusdt: string; tbtc: string; confirmations: number }
export function tronConfig(c: Config): TronSettings | null {
  if (!c.TRON_FULL_HOST || !c.TRON_CHAIN_ID || !c.TRON_ESCROW_ADDRESS || !c.TRON_EXECUTOR_KEY || !c.TRON_ATTESTOR_KEY || !c.TRON_TUSDT || !c.TRON_TBTC) return null;
  const hex = (k: string) => (k.startsWith('0x') ? k : '0x' + k) as `0x${string}`;
  return { fullHost: c.TRON_FULL_HOST, chainId: Number(c.TRON_CHAIN_ID), escrow: c.TRON_ESCROW_ADDRESS, executorKey: c.TRON_EXECUTOR_KEY.replace(/^0x/, ''), attestorKey: hex(c.TRON_ATTESTOR_KEY), tusdt: c.TRON_TUSDT, tbtc: c.TRON_TBTC, confirmations: c.TRON_CONFIRMATIONS };
}

