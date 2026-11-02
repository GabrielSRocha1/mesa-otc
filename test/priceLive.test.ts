/** Preço AO VIVO (CoinGecko) — refresher single-flight + fonte fail-closed (incidente op 3 mainnet). */
import { describe, it, expect } from 'vitest';
import { CoinGeckoRefresher, LivePriceSource } from '../src/engines/priceLive.js';
import { PriceEngine } from '../src/engines/price.js';

const BTC = 'bip122:mainnet/slip44:0';
const ETH = 'eip155:1/slip44:60';
const STATIC_ID = 'eip155:31337/slip44:60'; // não-vivo: comportamento estático intacto

type FetchLike = typeof fetch;
const okFetch = (body: unknown): FetchLike => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as FetchLike;
const failFetch: FetchLike = (async () => { throw new Error('rede fora'); }) as unknown as FetchLike;

function setup(fetchImpl: FetchLike, nowRef: { t: number }) {
  const map: Record<string, number> = { [BTC]: 64_230.5, [ETH]: 2_418.75, [STATIC_ID]: 2_418.75 };
  const ref = new CoinGeckoRefresher(map, { [BTC]: 'bitcoin', [ETH]: 'ethereum' }, 45_000, fetchImpl, () => nowRef.t);
  const live = new Set([BTC, ETH]);
  const mk = (n: string, w: number) => new LivePriceSource(n, w, map, ref, live);
  return { map, ref, sources: [mk('Pyth', 1), mk('Chainlink', 1), mk('Coinbase', 0.8), mk('Kraken', 0.8)] };
}

describe('CoinGeckoRefresher + LivePriceSource', () => {
  it('busca única atualiza o mapa e o engine cota o valor AO VIVO (não a semente)', async () => {
    const now = { t: 1_000_000 };
    const { map, sources } = setup(okFetch({ bitcoin: { usd: 77_700 }, ethereum: { usd: 2_255.8 } }), now);
    const engine = new PriceEngine(sources, undefined, () => now.t);
    const snap = await engine.quote([BTC, ETH]);
    expect(snap.reference[BTC]).toBe(77_700);
    expect(snap.reference[ETH]).toBe(2_255.8);
    expect(snap.anomaly).toBe(false); // 4 fontes servindo o MESMO mapa → dispersão 0, disjuntor quieto
    expect(map[STATIC_ID]).toBe(2_418.75); // id não-vivo intocado
  });

  it('fail-closed: CoinGecko nunca respondeu → cotação mainnet FALHA (nunca serve a semente estática)', async () => {
    const now = { t: 1_000_000 };
    const { sources } = setup(failFetch, now);
    const engine = new PriceEngine(sources, undefined, () => now.t);
    await expect(engine.quote([BTC])).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  it('cotação VELHA (CoinGecko caiu após 1ª busca boa) é rejeitada pelo maxQuoteAgeMs', async () => {
    const now = { t: 1_000_000 };
    let calls = 0;
    const flaky: FetchLike = (async () => { calls++; if (calls === 1) return { ok: true, status: 200, json: async () => ({ bitcoin: { usd: 77_700 }, ethereum: { usd: 2_255.8 } }) }; throw new Error('rede fora'); }) as unknown as FetchLike;
    const { sources } = setup(flaky, now);
    const engine = new PriceEngine(sources, undefined, () => now.t);
    await engine.quote([BTC]); // 1ª busca boa
    now.t += 120_000; // 2 min depois (TTL 45s vencido + maxQuoteAgeMs 60s estourado)
    await expect(engine.quote([BTC])).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  it('CoinGecko 429 → FALLBACK Coinbase spot entrega o preço ao vivo', async () => {
    const now = { t: 1_000_000 };
    const routed: FetchLike = (async (url: string) => {
      if (String(url).includes('coingecko')) return { ok: false, status: 429, json: async () => ({}) };
      const pair = /prices\/([A-Z-]+)\/spot/.exec(String(url))![1];
      const amount = pair === 'BTC-USD' ? '77700' : '2255.8';
      return { ok: true, status: 200, json: async () => ({ data: { amount } }) };
    }) as unknown as FetchLike;
    const { sources } = setup(routed, now);
    const engine = new PriceEngine(sources, undefined, () => now.t);
    const snap = await engine.quote([BTC, ETH]);
    expect(snap.reference[BTC]).toBe(77_700);
    expect(snap.reference[ETH]).toBe(2_255.8);
  });

  it('id não-vivo segue o caminho estático puro (sem rede)', async () => {
    const now = { t: 1_000_000 };
    const { sources } = setup(failFetch, now);
    const p = await sources[0]!.getPriceUsd(STATIC_ID);
    expect(p).toBe(2_418.75);
  });
});
