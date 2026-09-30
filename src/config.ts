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
  // Liquidação via contrato REAL numa rede EVM de teste (Sepolia/anvil). Todas opcionais:
  // sem o conjunto completo, o modo simulado (LocalChainAdapter) permanece intacto.
  EVM_RPC_URL: z.string().optional(),
  EVM_CHAIN_ID: z.string().optional(),
  EVM_ESCROW_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  EVM_KEEPER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  EVM_TBTC: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  EVM_TUSDT: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  EVM_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(1),
  EVM_EXPLORER_BASE: z.string().optional(),
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
  // Modo EVM: ou o conjunto essencial completo, ou nada (evita meia-configuração silenciosa).
  const evmKeys = [c.EVM_RPC_URL, c.EVM_CHAIN_ID, c.EVM_ESCROW_ADDRESS, c.EVM_KEEPER_KEY, c.EVM_TBTC, c.EVM_TUSDT];
  const evmSet = evmKeys.filter(Boolean).length;
  if (evmSet > 0 && evmSet < evmKeys.length) throw new Error('Modo EVM exige TODAS as envs: EVM_RPC_URL, EVM_CHAIN_ID, EVM_ESCROW_ADDRESS, EVM_KEEPER_KEY, EVM_TBTC, EVM_TUSDT (rode npm run contracts:deploy)');
  return { ...c, sessionSecret, identityMasterSecret, operators: new Set(c.OPERATOR_ADDRESSES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) };
}

/** Configuração do modo EVM (contrato real). null = modo simulado. */
export interface EvmSettings { rpcUrl: string; chainId: string; escrow: `0x${string}`; keeperKey: `0x${string}`; tbtc: `0x${string}`; tusdt: `0x${string}`; confirmations: number; explorerBase: string | null }
export function evmConfig(c: Config): EvmSettings | null {
  if (!c.EVM_RPC_URL || !c.EVM_CHAIN_ID || !c.EVM_ESCROW_ADDRESS || !c.EVM_KEEPER_KEY || !c.EVM_TBTC || !c.EVM_TUSDT) return null;
  return { rpcUrl: c.EVM_RPC_URL, chainId: c.EVM_CHAIN_ID, escrow: c.EVM_ESCROW_ADDRESS as `0x${string}`, keeperKey: c.EVM_KEEPER_KEY as `0x${string}`, tbtc: c.EVM_TBTC as `0x${string}`, tusdt: c.EVM_TUSDT as `0x${string}`, confirmations: c.EVM_CONFIRMATIONS, explorerBase: c.EVM_EXPLORER_BASE?.replace(/\/$/, '') ?? null };
}
