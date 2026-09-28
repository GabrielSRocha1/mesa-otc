/**
 * Asset Registry — registro canônico (RA-*). Resolução por (network, chainId, contractOrMint), nunca por símbolo,
 * e verificação on-chain via adaptador (bytecode/mint authority/decimals/standard/issuer).
 */
import type { CanonicalAsset, Network } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import type { AdapterRegistry, AssetVerification } from '../adapters/types.js';

export interface AssetRef { network: Network; chainId: string; contractOrMint: string | null }

export class AssetRegistry {
  private byKey = new Map<string, CanonicalAsset>();
  constructor(entries: CanonicalAsset[] = []) { entries.forEach(e => this.add(e)); }
  static key(r: AssetRef): string { return `${r.network}|${r.chainId}|${(r.contractOrMint ?? 'native').toLowerCase()}`; }
  add(a: CanonicalAsset): void { this.byKey.set(AssetRegistry.key(a), a); }
  list(): CanonicalAsset[] { return [...this.byKey.values()]; }
  /** Resolve pelo identificador canônico; símbolo é ignorado para fins de identificação. */
  resolve(ref: AssetRef): CanonicalAsset {
    const a = this.byKey.get(AssetRegistry.key(ref));
    if (!a) throw new DomainError('ASSET_NOT_CANONICAL', 'Ativo fora do registro canônico', { ref });
    if (a.status !== 'active') throw new DomainError('ASSET_NOT_CANONICAL', `Ativo com status ${a.status}`, { assetId: a.assetId });
    return a;
  }
  resolveByAssetId(assetId: string): CanonicalAsset { const a = this.list().find(x => x.assetId === assetId); if (!a || a.status !== 'active') throw new DomainError('ASSET_NOT_CANONICAL', 'assetId desconhecido', { assetId }); return a; }
  /** Verificação em tempo de Deal (RA-020..022): compara o registro com o observado on-chain. */
  async verifyOnChain(asset: CanonicalAsset, adapters: AdapterRegistry): Promise<AssetVerification> {
    const adapter = adapters.get(asset.network); if (!adapter) throw new DomainError('ADAPTER_UNAVAILABLE', `Sem adaptador para ${asset.network}`);
    const v = await adapter.verifyAsset(asset);
    if (!v.ok) throw new DomainError('ASSET_VERIFICATION_FAILED', `Ativo ${asset.code} em ${asset.network} falhou na verificação: ${v.reasons.join('; ')}`, { reasons: v.reasons, observed: v.observed });
    return v;
  }
}

/** Registro inicial (dev/local). Em produção as entradas vêm do banco com aprovação four-eyes (RS-021). */
export function defaultRegistry(chainIds: { ethereum: string; solana: string; bitcoin: string }, tokens: { usdtEth: string; usdcEth: string; usdtSol: string; usdcSol: string }, codeHashes: { usdtEth: string; usdcEth: string }, mintAuth: { usdtSol: string | null; usdcSol: string | null }): AssetRegistry {
  return new AssetRegistry([
    { code: 'BTC', network: 'bitcoin', chainId: chainIds.bitcoin, contractOrMint: null, assetId: `bip122:${chainIds.bitcoin}/slip44:0`, decimals: 8, tokenStandard: 'native', issuer: 'native', status: 'active' },
    { code: 'ETH', network: 'ethereum', chainId: chainIds.ethereum, contractOrMint: null, assetId: `eip155:${chainIds.ethereum}/slip44:60`, decimals: 18, tokenStandard: 'native', issuer: 'native', status: 'active' },
    { code: 'SOL', network: 'solana', chainId: chainIds.solana, contractOrMint: null, assetId: `solana:${chainIds.solana}/slip44:501`, decimals: 9, tokenStandard: 'native', issuer: 'native', status: 'active' },
    { code: 'USDT', network: 'ethereum', chainId: chainIds.ethereum, contractOrMint: tokens.usdtEth, assetId: `eip155:${chainIds.ethereum}/erc20:${tokens.usdtEth.toLowerCase()}`, decimals: 6, tokenStandard: 'ERC-20', issuer: 'Tether', status: 'active', expectedCodeHash: codeHashes.usdtEth },
    { code: 'USDC', network: 'ethereum', chainId: chainIds.ethereum, contractOrMint: tokens.usdcEth, assetId: `eip155:${chainIds.ethereum}/erc20:${tokens.usdcEth.toLowerCase()}`, decimals: 6, tokenStandard: 'ERC-20', issuer: 'Circle', status: 'active', expectedCodeHash: codeHashes.usdcEth },
    { code: 'USDT', network: 'solana', chainId: chainIds.solana, contractOrMint: tokens.usdtSol, assetId: `solana:${chainIds.solana}/token:${tokens.usdtSol}`, decimals: 6, tokenStandard: 'SPL', issuer: 'Tether', status: 'active', expectedMintAuthority: mintAuth.usdtSol },
    { code: 'USDC', network: 'solana', chainId: chainIds.solana, contractOrMint: tokens.usdcSol, assetId: `solana:${chainIds.solana}/token:${tokens.usdcSol}`, decimals: 6, tokenStandard: 'SPL', issuer: 'Circle', status: 'active', expectedMintAuthority: mintAuth.usdcSol },
    { code: 'ZEC', network: 'zcash', chainId: 'mainnet', contractOrMint: null, assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133', decimals: 8, tokenStandard: 'native', issuer: 'native', status: 'suspended' }
  ]);
}
