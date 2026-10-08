/**
 * Validação ÚNICA de saldos da mesa: ativo exigido de cada cadeira + gás (token nativo ≥ MIN_GAS_USD)
 * dos Pay Masters e depositantes. Sempre on-chain (nunca cache/frontend); chamada na exibição,
 * no "Aprovar operação" e imediatamente antes de cada assinatura. Motivos nominais em PT-BR.
 */
import { MIN_GAS_USD, MIN_GAS_NATIVE_FALLBACK } from '../domain/constants.js';
import { readNativeBalance } from '../chains/balances.js';
import { readTokenBalances } from '../chains/tokenBalances.js';
import { getPricesById } from '../chains/prices.js';
import { getChain } from '../chains/registry.js';
import { CHAIR_ROLE_LABEL } from './mesaService.js';
import type { MesaRecord, MesaChair } from './types.js';

export interface ChairBalance {
  chairId: string; role: MesaChair['role']; roleLabel: string; firstName: string | null;
  assetSymbol: string; assetAmount: number | null; assetRequired: number | null; assetOk: boolean | null;
  gasSymbol: string | null; gasAmount: number | null; gasUsd: number | null; gasOk: boolean | null;
}
export interface BalanceReport { ok: boolean; checkedAt: number; chairs: ChairBalance[]; failures: string[] }

/** Leitores injetáveis (testes usam mocks; produção usa os leitores on-chain reais). */
export interface BalanceReaders {
  native(network: string, address: string): Promise<{ amount: number } | null>;
  tokens(network: string, address: string): Promise<{ symbol: string; contract: string | null; amount: number }[]>;
  priceUsdOf(network: string): Promise<number | null>;
  /** Leitura DIRETA do contrato da cadeira (balanceOf) — tokens de teste/custom não estão no
   *  catálogo público; sem isto o precheck reportava "insuficiente" com saldo real na carteira. */
  tokenDirect?(network: string, contract: string, address: string, decimals: number): Promise<number | null>;
}

export function defaultBalanceReaders(): BalanceReaders {
  return {
    native: async (network, address) => { const r = await readNativeBalance(network, address).catch(() => null); return r && r.amount != null ? { amount: r.amount } : null; },
    tokens: async (network, address) => (await readTokenBalances(network, address).catch(() => [])).map(t => ({ symbol: t.symbol, contract: t.contract, amount: t.amount })),
    priceUsdOf: async network => { const chain = getChain(network); if (!chain) return null; const byId = await getPricesById().catch(() => ({} as Record<string, { usd: number | null }>)); return byId[chain.coingeckoId]?.usd ?? null; },
    tokenDirect: async (network, contract, address, decimals) => {
      const c = getChain(network); if (!c || c.family !== 'evm') return null; // EVM por ora; demais caem no catálogo
      try {
        const data = '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
        const r = await fetch(c.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }) });
        const j = await r.json() as { result?: string };
        if (!j?.result || j.result === '0x') return null;
        return Number(BigInt(j.result)) / 10 ** decimals;
      } catch { return null; }
    },
  };
}

const fmt = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 6 });

/**
 * Revalida on-chain o saldo do ativo exigido e o gás de cada cadeira conectada.
 * `requiredOf` devolve a quantidade exigida (unidades humanas) do ativo da cadeira — null quando
 * o papel não deposita (Pay Masters) ou quando a quantidade ainda não foi configurada.
 */
export async function validateChairBalances(mesa: MesaRecord, readers: BalanceReaders, now: number, requiredOf?: (chair: MesaChair) => number | null): Promise<BalanceReport> {
  const failures: string[] = [];
  const chairs: ChairBalance[] = [];
  for (const chair of mesa.chairs) {
    const label = CHAIR_ROLE_LABEL[chair.role];
    const who = chair.firstName ? `${label} (${chair.firstName})` : label;
    if (!chair.wallet) {
      failures.push(`${who}: carteira ainda não conectada`);
      chairs.push({ chairId: chair.chairId, role: chair.role, roleLabel: label, firstName: chair.firstName ?? null, assetSymbol: chair.expectedAsset.symbol, assetAmount: null, assetRequired: null, assetOk: null, gasSymbol: null, gasAmount: null, gasUsd: null, gasOk: null });
      continue;
    }
    const net = chair.expectedAsset.network || mesa.network;
    const chain = getChain(net);
    const address = addressOn(chair, net);
    // ---- gás: token nativo ≥ US$ 5 (fallback por rede quando o preço está indisponível) ----
    const native = address ? await readers.native(net, address) : null;
    const price = await readers.priceUsdOf(net);
    let gasOk: boolean | null; let gasUsd: number | null = null;
    if (native == null) { gasOk = false; failures.push(`${who}: não foi possível ler o saldo de gás on-chain`); }
    else if (price != null) { gasUsd = native.amount * price; gasOk = gasUsd >= MIN_GAS_USD; if (!gasOk) failures.push(`${who}: gás abaixo de US$ ${MIN_GAS_USD} (tem ≈ US$ ${gasUsd.toFixed(2)})`); }
    else { const min = MIN_GAS_NATIVE_FALLBACK[net]; if (min != null) { gasOk = native.amount >= min; if (!gasOk) failures.push(`${who}: gás abaixo do mínimo de ${fmt(min)} ${chain?.nativeSymbol ?? ''}`.trim()); } else { gasOk = false; failures.push(`${who}: preço do gás indisponível para validar o mínimo de US$ ${MIN_GAS_USD}`); } }
    // ---- ativo exigido da cadeira ----
    const required = requiredOf ? requiredOf(chair) : null;
    let assetAmount: number | null = null; let assetOk: boolean | null = null;
    if (required != null && address) {
      if (chair.expectedAsset.contractOrMint == null) assetAmount = native?.amount ?? null;
      else {
        // 1º leitura DIRETA do contrato (cobre tokens de teste/custom fora do catálogo público).
        const direct = await readers.tokenDirect?.(net, chair.expectedAsset.contractOrMint, address, chair.expectedAsset.decimals);
        if (direct != null) assetAmount = direct;
        else { const toks = await readers.tokens(net, address); const hit = toks.find(t => t.contract?.toLowerCase() === chair.expectedAsset.contractOrMint?.toLowerCase() || t.symbol === chair.expectedAsset.symbol); assetAmount = hit?.amount ?? 0; }
      }
      if (assetAmount == null) { assetOk = false; failures.push(`${who}: não foi possível ler o saldo de ${chair.expectedAsset.symbol}`); }
      else { assetOk = assetAmount >= required; if (!assetOk) failures.push(`${who}: saldo de ${chair.expectedAsset.symbol} insuficiente (faltam ${fmt(required - assetAmount)})`); }
    }
    chairs.push({ chairId: chair.chairId, role: chair.role, roleLabel: label, firstName: chair.firstName ?? null, assetSymbol: chair.expectedAsset.symbol, assetAmount, assetRequired: required, assetOk, gasSymbol: chain?.nativeSymbol ?? null, gasAmount: native?.amount ?? null, gasUsd, gasOk });
  }
  return { ok: failures.length === 0, checkedAt: now, chairs, failures };
}

/** Endereço da cadeira na rede pedida (carteira multichain expõe vários endereços). */
export function addressOn(chair: MesaChair, network: string): string | null {
  const w = chair.wallet;
  if (!w) return null;
  const hit = (w.addresses ?? []).find(a => a.network === network);
  if (hit) return hit.address;
  return w.network === network || !w.addresses?.length ? w.address : w.address;
}
