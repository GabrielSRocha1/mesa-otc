/**
 * tokens.ts — Whitelist curada de tokens por rede (fase 2 dos saldos).
 *
 * Ler TODOS os tokens de um endereço sem indexador pago não é viável nas redes
 * EVM; então usamos uma whitelist dos tokens mais relevantes (stablecoins +
 * majors) e consultamos balanceOf. Solana enumera de verdade (RPC público
 * getTokenAccountsByOwner) e usa este mapa só para símbolo/decimais/preço dos
 * mints conhecidos. Contratos verificados nos exploradores oficiais.
 *
 * Editar aqui = adicionar/remover token. `coingeckoId` alimenta o preço.
 */

export interface TokenDef {
  symbol: string;
  /** contrato ERC-20 (EVM), mint (Solana) ou contrato TRC-20 (Tron). */
  contract: string;
  decimals: number;
  coingeckoId: string;
}

export const TOKENS: Record<string, TokenDef[]> = {
  ethereum: [
    { symbol: 'USDT', contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6,  coingeckoId: 'tether' },
    { symbol: 'USDC', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,  coingeckoId: 'usd-coin' },
    { symbol: 'DAI',  contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, coingeckoId: 'dai' },
    { symbol: 'WBTC', contract: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8,  coingeckoId: 'wrapped-bitcoin' },
  ],
  bsc: [
    { symbol: 'USDT', contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, coingeckoId: 'tether' },
    { symbol: 'USDC', contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, coingeckoId: 'usd-coin' },
    { symbol: 'BUSD', contract: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18, coingeckoId: 'binance-usd' },
  ],
  polygon: [
    { symbol: 'USDT',  contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6,  coingeckoId: 'tether' },
    { symbol: 'USDC',  contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6,  coingeckoId: 'usd-coin' },
    { symbol: 'USDC.e',contract: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6,  coingeckoId: 'usd-coin' },
    { symbol: 'DAI',   contract: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, coingeckoId: 'dai' },
  ],
  arbitrum: [
    { symbol: 'USDT', contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6,  coingeckoId: 'tether' },
    { symbol: 'USDC', contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6,  coingeckoId: 'usd-coin' },
    { symbol: 'DAI',  contract: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, coingeckoId: 'dai' },
  ],
  base: [
    { symbol: 'USDC', contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,  coingeckoId: 'usd-coin' },
    { symbol: 'DAI',  contract: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, coingeckoId: 'dai' },
  ],
  optimism: [
    { symbol: 'USDT', contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6,  coingeckoId: 'tether' },
    { symbol: 'USDC', contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6,  coingeckoId: 'usd-coin' },
    { symbol: 'DAI',  contract: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, coingeckoId: 'dai' },
  ],
  avalanche: [
    { symbol: 'USDT', contract: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6, coingeckoId: 'tether' },
    { symbol: 'USDC', contract: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, coingeckoId: 'usd-coin' },
  ],
  cronos: [
    { symbol: 'USDT', contract: '0x66e428c3f67a68878562e79A0234c1F83c208770', decimals: 6, coingeckoId: 'tether' },
    { symbol: 'USDC', contract: '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59', decimals: 6, coingeckoId: 'usd-coin' },
  ],
  solana: [
    { symbol: 'USDC', contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, coingeckoId: 'usd-coin' },
    { symbol: 'USDT', contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, coingeckoId: 'tether' },
  ],
  tron: [
    { symbol: 'USDT', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, coingeckoId: 'tether' },
    { symbol: 'USDC', contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', decimals: 6, coingeckoId: 'usd-coin' },
  ],
};

export function tokensFor(chainKey: string): TokenDef[] {
  return TOKENS[chainKey] ?? [];
}

/**
 * Redes (chainKeys) que têm USDT e USDC na whitelist — para o seletor de
 * recebimento da OTC só oferecer redes onde o stablecoin realmente existe.
 * USDC.e conta como USDC.
 */
export function stablecoinNetworks(): { USDT: string[]; USDC: string[] } {
  const out: { USDT: string[]; USDC: string[] } = { USDT: [], USDC: [] };
  for (const [chainKey, list] of Object.entries(TOKENS)) {
    if (list.some(t => t.symbol.toUpperCase().startsWith('USDT'))) out.USDT.push(chainKey);
    if (list.some(t => t.symbol.toUpperCase().startsWith('USDC'))) out.USDC.push(chainKey);
  }
  return out;
}

/** Todos os coingeckoIds de tokens (para o fetch de preços em lote). */
export function allTokenCoingeckoIds(): string[] {
  return [...new Set(Object.values(TOKENS).flat().map(t => t.coingeckoId))];
}

/** Mapa mint→TokenDef (Solana) para casar o que o RPC enumerar. */
export function solanaMintMap(): Record<string, TokenDef> {
  const out: Record<string, TokenDef> = {};
  for (const t of TOKENS.solana ?? []) out[t.contract] = t;
  return out;
}
