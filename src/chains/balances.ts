/**
 * balances.ts — Leitura do SALDO NATIVO de cada uma das 18 redes, a partir do
 * endereço público, usando endpoints públicos (sem chave) por família.
 *
 * Só leitura: nunca assina, deriva ou envia. Cada leitor tem timeout e devolve
 * `null` quando NÃO conseguiu ler (erro/tempo) — o que é diferente de saldo 0.
 * `0` só é retornado quando a rede confirma que a conta está vazia/inexistente.
 */
import { getChain, type ChainDef } from './registry.js';

export interface NativeBalance {
  /** unidades inteiras da base (lamports, wei, sats...) como string. */
  raw: string;
  /** valor decimal já dividido pelos decimais nativos (para exibição). */
  amount: number;
  symbol: string;
  decimals: number;
}

const TIMEOUT_MS = 8000;

export async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { accept: 'application/json', ...(init?.headers || {}) },
    });
    if (res.status === 404) return { __notFound: true };
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Converte inteiro de base (string/bigint) para decimal preservando precisão. */
export function fromBase(rawInt: bigint, decimals: number): number {
  const neg = rawInt < 0n;
  const abs = (neg ? -rawInt : rawInt).toString().padStart(decimals + 1, '0');
  const cut = abs.length - decimals;
  const s = abs.slice(0, cut) + '.' + abs.slice(cut);
  return Number((neg ? '-' : '') + s);
}

function pack(rawInt: bigint, c: ChainDef): NativeBalance {
  return { raw: rawInt.toString(), amount: fromBase(rawInt, c.nativeDecimals), symbol: c.nativeSymbol, decimals: c.nativeDecimals };
}

export async function rpcPost(endpoint: string, body: unknown): Promise<any> {
  return fetchJson(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

// ─── Leitores por família ────────────────────────────────────────────────────

async function readEvm(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await rpcPost(c.endpoint, { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] });
  if (!j || typeof j.result !== 'string') return null;
  try { return pack(BigInt(j.result), c); } catch { return null; }
}

async function readSolana(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await rpcPost(c.endpoint, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] });
  const v = j?.result?.value;
  if (typeof v !== 'number') return null;
  return pack(BigInt(v), c);
}

async function readBitcoin(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await fetchJson(`${c.endpoint}/address/${encodeURIComponent(address)}`);
  if (j?.__notFound) return pack(0n, c);
  const cs = j?.chain_stats;
  if (!cs) return null;
  const sats = BigInt(cs.funded_txo_sum ?? 0) - BigInt(cs.spent_txo_sum ?? 0);
  return pack(sats, c);
}

async function readTron(c: ChainDef, address: string): Promise<NativeBalance | null> {
  // O endpoint público /v1/accounts limita a 3 rps e devolve 429 (exige API key).
  // O nó /wallet/getaccount aceita o endereço base58 (visible:true), não é
  // limitado do mesmo jeito e devolve `{}` para conta ainda não ativada (= 0).
  // Em IP compartilhado (serverless) a TronGrid pode limitar mesmo assim; com
  // TRONGRID_API_KEY no env, envia o header TRON-PRO-API-KEY e escapa do limite.
  const key = process.env.TRONGRID_API_KEY?.trim();
  const j = await fetchJson(`${c.endpoint}/wallet/getaccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'TRON-PRO-API-KEY': key } : {}) },
    body: JSON.stringify({ address, visible: true }),
  });
  if (!j || typeof j !== 'object') return null;
  const bal = (j as { balance?: number | string }).balance;
  return pack(BigInt(bal ?? 0), c); // sem campo balance = conta vazia/não ativada
}

async function readXrp(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await rpcPost(`${c.endpoint}/`, { method: 'account_info', params: [{ account: address, ledger_index: 'validated' }] });
  const err = j?.result?.error;
  if (err === 'actNotFound') return pack(0n, c);
  const bal = j?.result?.account_data?.Balance;
  if (bal == null) return null;
  return pack(BigInt(bal), c);
}

async function readZcash(c: ChainDef, address: string): Promise<NativeBalance | null> {
  // Blockchair bloqueia IPs sem chave (HTTP 430). Com BLOCKCHAIR_API_KEY no env,
  // a leitura passa a funcionar; sem chave, devolve null (UI: "indisponível").
  const key = process.env.BLOCKCHAIR_API_KEY?.trim();
  const q = key ? `?key=${encodeURIComponent(key)}` : '';
  const j = await fetchJson(`${c.endpoint}/dashboards/address/${encodeURIComponent(address)}${q}`);
  if (j?.__notFound) return pack(0n, c);
  const bal = j?.data?.[address]?.address?.balance;
  if (bal == null) return null;
  return pack(BigInt(bal), c);
}

async function readTon(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await fetchJson(`${c.endpoint}/getAddressBalance?address=${encodeURIComponent(address)}`);
  const bal = j?.result;
  if (bal == null) return null;
  try { return pack(BigInt(bal), c); } catch { return null; }
}

async function readAptos(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const type = '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>';
  const j = await fetchJson(`${c.endpoint}/v1/accounts/${encodeURIComponent(address)}/resource/${encodeURIComponent(type)}`);
  if (j?.__notFound) return pack(0n, c); // sem CoinStore = 0
  const v = j?.data?.coin?.value;
  if (v == null) return null;
  return pack(BigInt(v), c);
}

async function readNear(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await rpcPost(c.endpoint, { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: address } });
  if (j?.error) {
    const msg = JSON.stringify(j.error);
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(msg)) return pack(0n, c);
    return null;
  }
  const amt = j?.result?.amount;
  if (amt == null) return null;
  return pack(BigInt(amt), c);
}

async function readAlgorand(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await fetchJson(`${c.endpoint}/v2/accounts/${encodeURIComponent(address)}`);
  if (j?.__notFound) return pack(0n, c);
  const amt = j?.amount;
  if (amt == null) return null;
  return pack(BigInt(amt), c);
}

async function readStellar(c: ChainDef, address: string): Promise<NativeBalance | null> {
  const j = await fetchJson(`${c.endpoint}/accounts/${encodeURIComponent(address)}`);
  if (j?.__notFound) return pack(0n, c); // conta não fundada
  const balances = j?.balances;
  if (!Array.isArray(balances)) return null;
  const native = balances.find((b: any) => b.asset_type === 'native');
  if (!native) return pack(0n, c);
  // Stellar já devolve decimal ("123.4567000"); converte para base inteira.
  const asInt = BigInt(Math.round(Number(native.balance) * 10 ** c.nativeDecimals));
  return pack(asInt, c);
}

/** Lê o saldo nativo de uma rede pelo chainKey (ou alias) + endereço. */
export async function readNativeBalance(network: string, address: string): Promise<NativeBalance | null> {
  const c = getChain(network);
  if (!c || !address) return null;
  switch (c.family) {
    case 'evm':      return readEvm(c, address);
    case 'solana':   return readSolana(c, address);
    case 'bitcoin':  return readBitcoin(c, address);
    case 'tron':     return readTron(c, address);
    case 'xrp':      return readXrp(c, address);
    case 'zcash':    return readZcash(c, address);
    case 'ton':      return readTon(c, address);
    case 'aptos':    return readAptos(c, address);
    case 'near':     return readNear(c, address);
    case 'algorand': return readAlgorand(c, address);
    case 'stellar':  return readStellar(c, address);
    default:         return null;
  }
}
