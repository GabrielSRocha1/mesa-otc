// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/registry/src/registry.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
import { z } from "zod";
import { type ChainId, type TokenEntry, TokenStatus, type ValidationResult, fail, ok } from "../types.js";
import { normalizeAddress } from "../core/index.js";

export const TokenEntrySchema = z.object({
  chainId: z.number().int(),
  address: z.string().min(1),
  tokenProgram: z.enum(["TOKEN", "TOKEN_2022"]).optional(),
  decimals: z.number().int().min(0).max(18),
  symbol: z.string().min(1).max(16),
  status: z.enum(TokenStatus),
  registryVersion: z.number().int().min(1),
  activatedAt: z.number().int(),
  updatedAt: z.number().int(),
  representationOf: z.string().optional(),
  allowFreezeAuthority: z.boolean().optional(),
  verifiedAgainstIssuer: z.boolean(),
});

export const RegistryFileSchema = z.object({
  version: z.number().int().min(1),
  updatedAt: z.string(),
  tokens: z.array(TokenEntrySchema),
});

export type RegistryFile = z.infer<typeof RegistryFileSchema>;

/**
 * Token Registry off-chain (índice). O registry on-chain de cada contrato/programa é a autoridade
 * para o escrow; este espelho serve ao Router para pré-validar e rejeitar cedo.
 */
export class TokenRegistry {
  private readonly byKey = new Map<string, TokenEntry>();
  readonly version: number;

  constructor(file: RegistryFile) {
    const parsed = RegistryFileSchema.parse(file);
    this.version = parsed.version;
    for (const t of parsed.tokens) this.byKey.set(key(t.chainId as ChainId, t.address), t as TokenEntry);
  }

  static fromJson(json: string): TokenRegistry {
    return new TokenRegistry(JSON.parse(json));
  }

  getToken(chainId: ChainId, address: string): TokenEntry | undefined {
    return this.byKey.get(key(chainId, address));
  }

  isActive(chainId: ChainId, address: string): boolean {
    return this.getToken(chainId, address)?.status === TokenStatus.ACTIVE;
  }

  list(chainId?: ChainId): TokenEntry[] {
    return [...this.byKey.values()].filter((t) => chainId === undefined || t.chainId === chainId);
  }

  /** Nunca localizar token por símbolo para fins de autorização: existe só para a UI (pode retornar vários). */
  findBySymbolForDisplay(chainId: ChainId, symbol: string): TokenEntry[] {
    return this.list(chainId).filter((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
  }

  /** Verificação de ativação para mainnet: nenhum token sem verificação humana contra o emissor. */
  assertMainnetReady(chainId: ChainId): ValidationResult {
    const bad = this.list(chainId).filter((t) => t.status === TokenStatus.ACTIVE && !t.verifiedAgainstIssuer);
    if (bad.length) return fail("UNVERIFIED_TOKENS", `tokens ACTIVE sem verificação: ${bad.map((b) => b.address).join(", ")}`);
    return ok();
  }
}

function key(chainId: ChainId, address: string): string {
  return `${chainId}:${normalizeAddress(chainId, address)}`;
}
