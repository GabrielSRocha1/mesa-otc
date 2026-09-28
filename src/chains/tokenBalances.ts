/**
 * tokenBalances.ts — Saldo de TOKENS por rede (fase 2), leitura pública.
 *
 *  - EVM: balanceOf(address) via eth_call para cada token da whitelist.
 *  - Solana: getTokenAccountsByOwner (Token + Token-2022) enumera TODOS os SPL
 *    do dono; whitelist só fornece símbolo/preço dos mints conhecidos.
 *  - Tron: TronGrid devolve o array trc20 do endereço; casa com a whitelist.
 *
 * Nunca assina/envia. Só devolve tokens com saldo > 0.
 */
import { getChain } from './registry.js';
import { tokensFor, solanaMintMap, type TokenDef } from './tokens.js';
import { fetchJson, rpcPost, fromBase } from './balances.js';

export interface TokenBalance {
  symbol: string;
  contract: string;
  decimals: number;
  amount: number;
  /** id de preço; '' quando token desconhecido (sem preço). */
  coingeckoId: string;
}

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Teto de segurança de tokens por endereço (evita payloads patológicos). */
const MAX_TOKENS = 50;

// ─── EVM: balanceOf via eth_call ─────────────────────────────────────────────

async function evmBalanceOf(endpoint: string, contract: string, owner: string): Promise<bigint | null> {
  const data = '0x70a08231' + owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const j = await rpcPost(endpoint, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] });
  const hex = j?.result;
  if (typeof hex !== 'string' || hex === '0x' || hex.length < 3) return hex === '0x' ? 0n : null;
  try { return BigInt(hex); } catch { return null; }
}

async function readEvmTokens(chainKey: string, endpoint: string, address: string): Promise<TokenBalance[]> {
  const list = tokensFor(chainKey);
  const out = await Promise.all(list.map(async (t): Promise<TokenBalance | null> => {
    const raw = await evmBalanceOf(endpoint, t.contract, address).catch(() => null);
    if (raw == null || raw <= 0n) return null;
    return { symbol: t.symbol, contract: t.contract, decimals: t.decimals, amount: fromBase(raw, t.decimals), coingeckoId: t.coingeckoId };
  }));
  return out.filter((x): x is TokenBalance => x !== null);
}

// ─── Solana: enumeração real via getTokenAccountsByOwner ─────────────────────

async function readSolanaTokens(endpoint: string, owner: string): Promise<TokenBalance[]> {
  const known = solanaMintMap();
  // Um dono pode ter VÁRIAS contas de token do mesmo mint — agrega por mint.
  const byMint = new Map<string, { meta: TokenDef; raw: bigint; decimals: number }>();
  for (const programId of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
    const j = await rpcPost(endpoint, {
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [owner, { programId }, { encoding: 'jsonParsed' }],
    });
    const accounts = j?.result?.value;
    if (!Array.isArray(accounts)) continue;
    for (const acc of accounts) {
      const info = acc?.account?.data?.parsed?.info;
      const mint = info?.mint;
      const ta = info?.tokenAmount;
      if (!mint || !ta) continue;
      // v1: só mints conhecidos (whitelist). Carteiras Solana acumulam milhares
      // de tokens-poeira/spam sem preço — enumerar todos poluiria a UI. Tokens
      // desconhecidos ficam ocultos até termos uma fonte de preço por mint.
      const meta: TokenDef | undefined = known[mint];
      if (!meta) continue;
      let raw: bigint;
      try { raw = BigInt(ta.amount ?? '0'); } catch { continue; }
      if (raw <= 0n) continue;
      const decimals = typeof ta.decimals === 'number' ? ta.decimals : meta.decimals;
      const cur = byMint.get(mint);
      if (cur) cur.raw += raw; else byMint.set(mint, { meta, raw, decimals });
    }
  }
  return [...byMint.entries()].map(([mint, v]) => ({
    symbol: v.meta.symbol, contract: mint, decimals: v.decimals, amount: fromBase(v.raw, v.decimals), coingeckoId: v.meta.coingeckoId,
  }));
}

// ─── Tron: TRC-20 via TronGrid ───────────────────────────────────────────────

async function readTronTokens(endpoint: string, address: string): Promise<TokenBalance[]> {
  const j = await fetchJson(`${endpoint}/v1/accounts/${encodeURIComponent(address)}`);
  const trc20 = j?.data?.[0]?.trc20;
  if (!Array.isArray(trc20)) return [];
  const byContract: Record<string, TokenDef> = {};
  for (const t of tokensFor('tron')) byContract[t.contract] = t;
  const out: TokenBalance[] = [];
  for (const entry of trc20) {
    for (const [contract, bal] of Object.entries(entry as Record<string, string>)) {
      const meta = byContract[contract];
      if (!meta) continue; // fase 2: só tokens da whitelist no Tron
      let raw: bigint;
      try { raw = BigInt(bal); } catch { continue; }
      if (raw <= 0n) continue;
      out.push({ symbol: meta.symbol, contract, decimals: meta.decimals, amount: fromBase(raw, meta.decimals), coingeckoId: meta.coingeckoId });
    }
  }
  return out;
}

/** Lê os tokens de um endereço na rede indicada (chainKey/alias). */
export async function readTokenBalances(network: string, address: string): Promise<TokenBalance[]> {
  const c = getChain(network);
  if (!c || !address) return [];
  try {
    let toks: TokenBalance[] = [];
    if (c.family === 'evm') toks = await readEvmTokens(c.chainKey, c.endpoint, address);
    else if (c.family === 'solana') toks = await readSolanaTokens(c.endpoint, address);
    else if (c.family === 'tron') toks = await readTronTokens(c.endpoint, address);
    return toks.slice(0, MAX_TOKENS);
  } catch {
    /* falha de leitura de token nunca derruba o saldo nativo */
  }
  return [];
}
