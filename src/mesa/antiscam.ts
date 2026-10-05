/**
 * Anti-scam de tokens da mesa: um token que SE DIZ USDT/USDC/WBTC… mas cujo contrato/mint não é o
 * endereço canônico do registro oficial é tratado como golpe e BLOQUEIA a aprovação (403).
 * Duas camadas, ambas injetáveis:
 *  1. registryChecker — cruza (símbolo, rede) com registryData.ts (espelho do registro on-chain).
 *  2. verumWalletChecker — consulta a API de segurança da Verum Wallet (VERUM_WALLET_SECURITY_URL),
 *     que mantém a lista viva de tokens maliciosos; indisponibilidade NÃO libera (fail-closed só
 *     para veredito explícito de malicioso; sem resposta, vale o veredito do registro).
 */
import registryData from '../onchain/registry/registryData.js';
import type { ChairAsset } from './types.js';

export interface TokenVerdict { ok: boolean; reason?: string }
export interface TokenSecurityChecker { check(asset: ChairAsset): Promise<TokenVerdict> }

/** Mesmo mapeamento rede→chainId usado pela rota /v1/tokens. */
export const CHAIN_ID_BY_NETWORK: Record<string, number> = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, solana: 101, tron: 728126428 };

const norm = (a: string | null | undefined): string => (a ?? '').trim().toLowerCase();

/** Endereços canônicos por (chainId, símbolo) a partir do registro oficial. */
function canonicalAddresses(chainId: number, symbol: string): string[] {
  return registryData.tokens
    .filter(t => t.chainId === chainId && t.status === 'ACTIVE' && t.symbol.toUpperCase() === symbol.toUpperCase())
    .map(t => norm(t.address));
}

/**
 * Checagem pelo registro: símbolo conhecido na rede + endereço divergente → golpe.
 * Nativo (contractOrMint null) e símbolos que o registro não conhece naquela rede passam
 * (tokens legítimos fora da lista continuam possíveis via modo avançado do wizard).
 * `allowed`: endereços extras tratados como canônicos (tokens de teste em dev: tUSDT/tBTC/mints locais).
 */
export function registryChecker(opts?: { allowed?: (string | null | undefined)[] }): TokenSecurityChecker {
  const allowed = new Set((opts?.allowed ?? []).filter((a): a is string => !!a).map(norm));
  return {
    async check(asset: ChairAsset): Promise<TokenVerdict> {
      if (asset.contractOrMint == null) return { ok: true }; // nativo (ex.: BTC no fluxo HTLC)
      if (allowed.has(norm(asset.contractOrMint))) return { ok: true };
      const chainId = CHAIN_ID_BY_NETWORK[asset.network];
      if (chainId === undefined) return { ok: true }; // rede fora do registro (ex.: bitcoin)
      const canonical = canonicalAddresses(chainId, asset.symbol);
      if (!canonical.length) return { ok: true };
      if (canonical.includes(norm(asset.contractOrMint))) return { ok: true };
      return { ok: false, reason: `token "${asset.symbol}" em ${asset.network} com contrato ${asset.contractOrMint} NÃO é o oficial do registro — possível golpe` };
    },
  };
}

/** Consulta remota à API de segurança da Verum Wallet (lista viva de tokens maliciosos). */
export function verumWalletChecker(baseUrl: string, fetchFn: typeof fetch = fetch): TokenSecurityChecker {
  return {
    async check(asset: ChairAsset): Promise<TokenVerdict> {
      if (asset.contractOrMint == null) return { ok: true };
      try {
        const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/token-security?network=${encodeURIComponent(asset.network)}&contract=${encodeURIComponent(asset.contractOrMint)}`, { headers: { accept: 'application/json' } });
        if (!res.ok) return { ok: true }; // sem veredito ≠ liberado como seguro; o registro decide
        const j = (await res.json()) as { malicious?: boolean; reason?: string };
        if (j.malicious) return { ok: false, reason: `token "${asset.symbol}" marcado como malicioso pela Verum Wallet${j.reason ? ` (${j.reason})` : ''}` };
        return { ok: true };
      } catch { return { ok: true }; }
    },
  };
}

/** Compõe as camadas: basta UMA acusar para bloquear. */
export function composeCheckers(...checkers: TokenSecurityChecker[]): TokenSecurityChecker {
  return {
    async check(asset: ChairAsset): Promise<TokenVerdict> {
      for (const c of checkers) { const v = await c.check(asset); if (!v.ok) return v; }
      return { ok: true };
    },
  };
}

/** Valida os ativos das cadeiras que depositam (Vendedor/Comprador). Retorna motivos nominais. */
export async function validateMesaTokens(chairs: { role: string; expectedAsset: ChairAsset }[], checker: TokenSecurityChecker): Promise<string[]> {
  const motivos: string[] = [];
  for (const c of chairs) {
    if (c.role !== 'SELLER' && c.role !== 'BUYER') continue;
    const v = await checker.check(c.expectedAsset);
    if (!v.ok) motivos.push(`${c.role === 'SELLER' ? 'Vendedor' : 'Comprador'}: ${v.reason ?? 'token reprovado na verificação de segurança'}`);
  }
  return motivos;
}
