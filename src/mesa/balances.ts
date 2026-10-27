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
import { deriveSettlementPlan } from './settlementPlan.js';
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

/** Última leitura BOA por chave (rede|endereço|contrato): RPCs públicos (ex.: devnet da Solana)
 *  rate-limitam e uma falha transitória virava saldo zero — o painel "piscava" e o precheck
 *  bloqueava aprovação com fundos reais na carteira. Retry com backoff; esgotado, vale a última
 *  leitura boa recente (≤ 10 min) em vez de null/0. */
const lastGood = new Map<string, { v: unknown; at: number }>();
async function sticky<T>(key: string, fn: () => Promise<T | null>, tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v !== null && v !== undefined) { lastGood.set(key, { v, at: Date.now() }); return v; } } catch { /* retry */ }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)));
  }
  const c = lastGood.get(key);
  return c && Date.now() - c.at < 10 * 60_000 ? c.v as T : null;
}

export function defaultBalanceReaders(): BalanceReaders {
  return {
    native: (network, address) => sticky(`n|${network}|${address}`, async () => { const r = await readNativeBalance(network, address); return r && r.amount != null ? { amount: r.amount } : null; }),
    tokens: async (network, address) => (await sticky(`t|${network}|${address}`, async () => { const l = await readTokenBalances(network, address); return l.length ? l : null; }) ?? []).map(t => ({ symbol: t.symbol, contract: t.contract, amount: t.amount })),
    priceUsdOf: network => sticky(`p|${network}`, async () => { const chain = getChain(network); if (!chain) return null; const byId = await getPricesById(); return byId[chain.coingeckoId]?.usd ?? null; }, 2),
    tokenDirect: (network, contract, address, decimals) => sticky(`d|${network}|${contract}|${address}`, async () => {
      const c = getChain(network); if (!c) return null;
      if (c.family === 'evm') {
        const data = '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
        const r = await fetch(c.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }) });
        const j = await r.json() as { result?: string };
        if (!j?.result || j.result === '0x') return null;
        return Number(BigInt(j.result)) / 10 ** decimals;
      }
      if (c.family === 'solana') {
        // getTokenAccountsByOwner filtrado pelo mint: cobre mints de teste/custom fora da
        // whitelist mainnet (que descartava o saldo real e bloqueava o precheck da mesa).
        const r = await fetch(c.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [address, { mint: contract }, { encoding: 'jsonParsed' }] }) });
        const j = await r.json() as { result?: { value?: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] } };
        const accounts = j?.result?.value; if (!accounts) return null;
        return Number(accounts.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n)) / 10 ** decimals;
      }
      return null; // demais famílias caem no catálogo
    }),
  };
}

const fmt = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 6 });

/** Nativos EMBRULHADOS: a tx de depósito/lock embrulha o que faltar na ponta (wSOL via SyncNative;
 *  WETH via deposit()). O saldo NATIVO cobre o exigido — sem este crédito o depositante que tem
 *  SOL/ETH mas nunca embrulhou aparece ZERADO no precheck. wSOL = mint base58 (case-sensitive);
 *  WETH = contrato hex (case-insensitive, guardado em minúsculas). */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const WETH_SEPOLIA = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
function isWrappedNative(contractOrMint: string | null): boolean {
  return contractOrMint === WSOL_MINT || contractOrMint?.toLowerCase() === WETH_SEPOLIA;
}

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
    // Cadeira LIGHTNING (Vendedor market-maker): o BTC é entregue pelo NÓ, não há saldo on-chain da
    // carteira para ler. A liquidez outbound do nó é checada no precheck de liquidez Lightning.
    if (chair.expectedAsset.network === 'lightning') {
      chairs.push({ chairId: chair.chairId, role: chair.role, roleLabel: label, firstName: chair.firstName ?? null, assetSymbol: chair.expectedAsset.symbol, assetAmount: null, assetRequired: null, assetOk: true, gasSymbol: null, gasAmount: null, gasUsd: null, gasOk: true });
      continue;
    }
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
      // Nativo embrulhado (wSOL/WETH): o nativo também cobre o exigido porque a tx de depósito/lock
      // embrulha o que faltar na ponta — sem isso o comprador com ETH (ou SOL) nunca embrulhado é
      // barrado com a ATA/ERC-20 zerada e o saldo "some" a cada leitura.
      if (isWrappedNative(chair.expectedAsset.contractOrMint) && native != null) assetAmount = (assetAmount ?? 0) + Math.max(0, native.amount - 0.01);
      if (assetAmount == null) { assetOk = false; failures.push(`${who}: não foi possível ler o saldo de ${chair.expectedAsset.symbol}`); }
      else { assetOk = assetAmount >= required; if (!assetOk) failures.push(`${who}: saldo de ${chair.expectedAsset.symbol} insuficiente (faltam ${fmt(required - assetAmount)})`); }
    }
    chairs.push({ chairId: chair.chairId, role: chair.role, roleLabel: label, firstName: chair.firstName ?? null, assetSymbol: chair.expectedAsset.symbol, assetAmount, assetRequired: required, assetOk, gasSymbol: chain?.nativeSymbol ?? null, gasAmount: native?.amount ?? null, gasUsd, gasOk });
  }
  // ---- gás da PERNA DE CONTRATO de quem entrega BTC (rota HTLC) ----
  // O signV2 de quem está do lado BTC sai da carteira DELE na rede do TOKEN (EVM/Tron) — o gate
  // acima só olha a rede da cadeira (bitcoin). Sem o nativo de lá, a falha só aparecia na VEZ DE
  // ASSINAR, com "[FAILED]" seco (incidente BTC↔Tron 2026-10-27: conta Tron do Vendedor nunca
  // ativada). Mesma régua de gás das cadeiras (US$ 5 / fallback por rede).
  const plan = deriveSettlementPlan(mesa.chairs);
  if (plan?.mode === 'HTLC_BTC' && plan.htlc) {
    const btcChair = mesa.chairs.find(c => c.role === plan.htlc!.btcSide);
    const tokenNet = plan.htlc.btcSide === 'SELLER' ? plan.buyerNetwork : plan.sellerNetwork;
    if (btcChair?.wallet && tokenNet && tokenNet !== 'bitcoin' && tokenNet !== 'lightning') {
      const label = CHAIR_ROLE_LABEL[btcChair.role];
      const who = btcChair.firstName ? `${label} (${btcChair.firstName})` : label;
      const chain = getChain(tokenNet);
      const netLabel = chain?.displayName ?? tokenNet;
      const addr = addressOn(btcChair, tokenNet);
      if (!addr) failures.push(`${who}: carteira sem endereço ${netLabel} — a assinatura do contrato sai de lá`);
      else {
        const native = await readers.native(tokenNet, addr);
        const price = await readers.priceUsdOf(tokenNet);
        const min = MIN_GAS_NATIVE_FALLBACK[tokenNet];
        const usd = native != null && price != null ? native.amount * price : null;
        const ok = native == null ? false : usd != null ? usd >= MIN_GAS_USD : min != null ? native.amount >= min : false;
        if (!ok) failures.push(`${who}: sem ${chain?.nativeSymbol ?? 'gás'} na rede ${netLabel} para assinar o contrato (mínimo ≈ US$ ${MIN_GAS_USD}${native != null ? `; tem ${fmt(native.amount)} ${chain?.nativeSymbol ?? ''}`.trimEnd() : ''})`);
      }
    }
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
