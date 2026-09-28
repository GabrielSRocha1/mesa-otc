/**
 * icons.ts — URLs dos ícones REAIS das moedas (logos oficiais), buscados de uma
 * fonte pública (CoinGecko /coins/markets, sem chave). RPC de blockchain NÃO
 * fornece logo — só saldo/estado; por isso o logo vem daqui, por coingeckoId.
 *
 * Cache longo em memória (logos quase nunca mudam).
 */
import { uniqueCoingeckoIds, uniqueIconIds } from './registry.js';
import { allTokenCoingeckoIds } from './tokens.js';

const TTL_MS = 24 * 3600 * 1000;
let cache: { at: number; map: Record<string, string> } | null = null;
let inflight: Promise<Record<string, string>> | null = null;

function allIds(): string[] {
  return [...new Set([...uniqueCoingeckoIds(), ...uniqueIconIds(), ...allTokenCoingeckoIds()])];
}

async function fetchIcons(): Promise<Record<string, string>> {
  const ids = allIds();
  const url =
    'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=' +
    encodeURIComponent(ids.join(',')) +
    '&per_page=250&page=1&sparkline=false';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const out: Record<string, string> = {};
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (res.ok) {
      const arr = (await res.json()) as Array<{ id?: string; image?: string }>;
      for (const c of arr) if (c && c.id && c.image) out[c.id] = c.image;
    }
  } catch {
    /* rede/tempo — devolve o que tiver; a UI cai no badge de fallback */
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/** Mapa coingeckoId → URL do logo, com cache (24h) e coalescência. */
export async function getIconMap(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.map;
  if (inflight) return inflight;
  inflight = fetchIcons()
    .then(map => {
      // Só cacheia se veio algo (evita fixar mapa vazio numa falha de rede).
      if (Object.keys(map).length) cache = { at: Date.now(), map };
      return cache ? cache.map : map;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
