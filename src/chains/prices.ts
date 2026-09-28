/**
 * prices.ts — Preços dos ativos nativos das 18 redes E dos tokens da whitelist,
 * via API pública de mercado (CoinGecko free, sem chave). Um único fetch em
 * lote (ids nativos ∪ ids de tokens), cacheado em memória (TTL curto).
 *
 * Fonte trocável: se quiser outra API pública, altere só `fetchFromSource`.
 */
import { uniqueCoingeckoIds, CHAINS } from './registry.js';
import { allTokenCoingeckoIds } from './tokens.js';

export interface PriceQuote { usd: number | null; brl: number | null }
/** Preço por chainKey (ex.: { solana: {usd, brl}, ethereum: {...} }). */
export type PriceMap = Record<string, PriceQuote>;
/** Preço por coingeckoId (ativos nativos e tokens). */
export type PriceById = Record<string, PriceQuote>;

const TTL_MS = 60_000;
let cache: { at: number; data: PriceById } | null = null;
let inflight: Promise<PriceById> | null = null;

function allIds(): string[] {
  return [...new Set([...uniqueCoingeckoIds(), ...allTokenCoingeckoIds()])];
}

async function fetchFromSource(): Promise<PriceById> {
  const ids = allIds();
  const url =
    'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(ids.join(',')) +
    '&vs_currencies=usd,brl';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let byId: Record<string, { usd?: number; brl?: number }> = {};
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (res.ok) byId = (await res.json()) as typeof byId;
  } catch {
    /* rede/tempo — devolve o que tiver (vazio) sem quebrar a leitura de saldo */
  } finally {
    clearTimeout(timer);
  }

  const out: PriceById = {};
  for (const id of ids) {
    const q = byId[id];
    out[id] = { usd: q?.usd ?? null, brl: q?.brl ?? null };
  }
  return out;
}

/** Preços por coingeckoId, com cache (TTL 60s) e coalescência de chamadas. */
export async function getPricesById(): Promise<PriceById> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = fetchFromSource()
    .then(data => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Preço de um coingeckoId (para tokens). Nunca lança. */
export async function priceOf(coingeckoId: string): Promise<PriceQuote> {
  const byId = await getPricesById().catch(() => ({} as PriceById));
  return byId[coingeckoId] ?? { usd: null, brl: null };
}

/** Preços dos ativos NATIVOS por chainKey (compat com a fase 1). */
export async function getPrices(): Promise<PriceMap> {
  const byId = await getPricesById();
  const out: PriceMap = {};
  for (const c of CHAINS) out[c.chainKey] = byId[c.coingeckoId] ?? { usd: null, brl: null };
  return out;
}
