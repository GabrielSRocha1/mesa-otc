/**
 * registry.ts — Fonte de verdade das 18 redes que a Verum Wallet lê, espelhada
 * aqui na OTC (a fonte original é `src/config/chains.ts` no repo verum-wallet).
 *
 * Só o necessário para LEITURA no lado OTC: símbolo/decimais do ativo nativo,
 * id de preço (mercado público) e o endpoint público de leitura de saldo por
 * família. NUNCA há chave privada, derivação nem envio aqui — só leitura.
 *
 * `chainKey` bate 1:1 com o `network` devolvido por `verum.getAddresses()`.
 */

export type ChainFamily =
  | 'solana' | 'evm' | 'bitcoin' | 'tron' | 'xrp' | 'zcash' | 'ton'
  | 'aptos' | 'near' | 'algorand' | 'stellar';

export interface ChainDef {
  chainKey: string;
  family: ChainFamily;
  displayName: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** id do ativo nativo no mercado de preços público (CoinGecko). */
  coingeckoId: string;
  /**
   * id do LOGO da rede no CoinGecko, quando difere do `coingeckoId` de preço.
   * L2s de gas em ETH (Arbitrum/Base/Optimism) precificam por 'ethereum', mas o
   * ícone tem de ser o da própria rede — senão herdam o logo do Ethereum.
   * `null` = rede sem logo próprio no CoinGecko (a UI usa override/fallback).
   */
  iconId?: string | null;
  /** Endpoint público (sem chave) para ler o saldo nativo dessa rede. */
  endpoint: string;
  /** URL base do explorador (para links na UI). */
  explorer: string;
}

/** As 18 redes, na mesma ordem/семântica de chains.ts (verum-wallet). */
export const CHAINS: readonly ChainDef[] = [
  { chainKey: 'solana',   family: 'solana',   displayName: 'Solana',            nativeSymbol: 'SOL',  nativeDecimals: 9,  coingeckoId: 'solana',            endpoint: 'https://api.mainnet-beta.solana.com',            explorer: 'https://solscan.io' },
  { chainKey: 'bitcoin',  family: 'bitcoin',  displayName: 'Bitcoin',           nativeSymbol: 'BTC',  nativeDecimals: 8,  coingeckoId: 'bitcoin',           endpoint: 'https://blockstream.info/api',                   explorer: 'https://blockstream.info' },
  { chainKey: 'ethereum', family: 'evm',      displayName: 'Ethereum',          nativeSymbol: 'ETH',  nativeDecimals: 18, coingeckoId: 'ethereum',          endpoint: 'https://ethereum-rpc.publicnode.com',            explorer: 'https://etherscan.io' },
  { chainKey: 'bsc',      family: 'evm',      displayName: 'BNB Smart Chain',   nativeSymbol: 'BNB',  nativeDecimals: 18, coingeckoId: 'binancecoin',       endpoint: 'https://bsc-rpc.publicnode.com',                 explorer: 'https://bscscan.com' },
  { chainKey: 'polygon',  family: 'evm',      displayName: 'Polygon',           nativeSymbol: 'POL',  nativeDecimals: 18, coingeckoId: 'matic-network',     endpoint: 'https://polygon-bor-rpc.publicnode.com',         explorer: 'https://polygonscan.com' },
  { chainKey: 'tron',     family: 'tron',     displayName: 'Tron',              nativeSymbol: 'TRX',  nativeDecimals: 6,  coingeckoId: 'tron',              endpoint: 'https://api.trongrid.io',                        explorer: 'https://tronscan.org' },
  { chainKey: 'arbitrum', family: 'evm',      displayName: 'Arbitrum One',      nativeSymbol: 'ETH',  nativeDecimals: 18, coingeckoId: 'ethereum',          iconId: 'arbitrum', endpoint: 'https://arbitrum-one-rpc.publicnode.com',        explorer: 'https://arbiscan.io' },
  { chainKey: 'base',     family: 'evm',      displayName: 'Base',              nativeSymbol: 'ETH',  nativeDecimals: 18, coingeckoId: 'ethereum',          iconId: null,       endpoint: 'https://base-rpc.publicnode.com',                explorer: 'https://basescan.org' },
  { chainKey: 'avalanche',family: 'evm',      displayName: 'Avalanche C-Chain', nativeSymbol: 'AVAX', nativeDecimals: 18, coingeckoId: 'avalanche-2',       endpoint: 'https://avalanche-c-chain-rpc.publicnode.com',   explorer: 'https://snowtrace.io' },
  { chainKey: 'cronos',   family: 'evm',      displayName: 'Cronos EVM',        nativeSymbol: 'CRO',  nativeDecimals: 18, coingeckoId: 'crypto-com-chain',  endpoint: 'https://evm.cronos.org',                         explorer: 'https://cronoscan.com' },
  { chainKey: 'optimism', family: 'evm',      displayName: 'Optimism',          nativeSymbol: 'ETH',  nativeDecimals: 18, coingeckoId: 'ethereum',          iconId: 'optimism', endpoint: 'https://optimism-rpc.publicnode.com',            explorer: 'https://optimistic.etherscan.io' },
  { chainKey: 'xrp',      family: 'xrp',      displayName: 'XRP Ledger',        nativeSymbol: 'XRP',  nativeDecimals: 6,  coingeckoId: 'ripple',            endpoint: 'https://s1.ripple.com:51234',                    explorer: 'https://xrpscan.com' },
  { chainKey: 'zcash',    family: 'zcash',    displayName: 'Zcash',             nativeSymbol: 'ZEC',  nativeDecimals: 8,  coingeckoId: 'zcash',             endpoint: 'https://api.blockchair.com/zcash',               explorer: 'https://blockchair.com/zcash' },
  { chainKey: 'ton',      family: 'ton',      displayName: 'TON',               nativeSymbol: 'TON',  nativeDecimals: 9,  coingeckoId: 'the-open-network',  endpoint: 'https://toncenter.com/api/v2',                   explorer: 'https://tonviewer.com' },
  { chainKey: 'aptos',    family: 'aptos',    displayName: 'Aptos',             nativeSymbol: 'APT',  nativeDecimals: 8,  coingeckoId: 'aptos',             endpoint: 'https://fullnode.mainnet.aptoslabs.com',         explorer: 'https://explorer.aptoslabs.com' },
  { chainKey: 'near',     family: 'near',     displayName: 'NEAR',              nativeSymbol: 'NEAR', nativeDecimals: 24, coingeckoId: 'near',              endpoint: 'https://rpc.mainnet.near.org',                   explorer: 'https://nearblocks.io' },
  { chainKey: 'algorand', family: 'algorand', displayName: 'Algorand',          nativeSymbol: 'ALGO', nativeDecimals: 6,  coingeckoId: 'algorand',          endpoint: 'https://mainnet-api.algonode.cloud',             explorer: 'https://allo.info' },
  { chainKey: 'stellar',  family: 'stellar',  displayName: 'Stellar',           nativeSymbol: 'XLM',  nativeDecimals: 7,  coingeckoId: 'stellar',           endpoint: 'https://horizon.stellar.org',                    explorer: 'https://stellar.expert/explorer/public' },
];

const BY_KEY = new Map<string, ChainDef>(CHAINS.map(c => [c.chainKey, c]));

/** Aliases tolerantes: nomes alternativos que já circulam na OTC/carteira. */
const ALIASES: Record<string, string> = {
  eth: 'ethereum', matic: 'polygon', 'binance-smart-chain': 'bsc', bnb: 'bsc',
  'avalanche-c': 'avalanche', avax: 'avalanche', op: 'optimism', arb: 'arbitrum',
  btc: 'bitcoin', sol: 'solana', trx: 'tron', ripple: 'xrp', zec: 'zcash',
};

export function normalizeChainKey(network: string | undefined | null): string | null {
  if (!network) return null;
  const k = String(network).trim().toLowerCase();
  if (BY_KEY.has(k)) return k;
  return ALIASES[k] ?? null;
}

export function getChain(network: string | undefined | null): ChainDef | undefined {
  const k = normalizeChainKey(network);
  return k ? BY_KEY.get(k) : undefined;
}

export function allChains(): ChainDef[] {
  return [...CHAINS];
}

/** Ids de preço únicos (várias redes EVM compartilham 'ethereum'). */
export function uniqueCoingeckoIds(): string[] {
  return [...new Set(CHAINS.map(c => c.coingeckoId))];
}

/** Id do LOGO de uma rede: `iconId` quando definido, senão o de preço. */
export function chainIconId(c: ChainDef): string | null {
  return c.iconId === undefined ? c.coingeckoId : c.iconId;
}

/** Ids de logo únicos a buscar (inclui os logos próprios das L2s). */
export function uniqueIconIds(): string[] {
  return [...new Set(CHAINS.map(chainIconId).filter((x): x is string => !!x))];
}
