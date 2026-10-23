/**
 * Operar Indexado — contratos do índice de preço (Verum Swap) e do registro de fixing.
 * Fonte do índice atrás de uma interface (IndexPriceProvider); a OTC usa o preço BRUTO (sem a fee de
 * 0,075% do swap) e a MEDIANA de ≥ minProviders fontes com dispersão controlada. Falha fechado.
 */

/** Ativo identificado por rede/contrato|mint (nunca só símbolo) + decimais (essenciais à matemática E18). */
export interface IndexAssetRef {
  network: string;
  /** chainId quando aplicável (EVM/Solana/Tron); null para redes sem o conceito. */
  chainId: string | null;
  /** contrato (EVM/Tron) ou mint (Solana); null = ativo nativo. */
  contractOrMint: string | null;
  decimals: number;
  symbol: string;
}

export interface IndexRequest {
  baseAsset: IndexAssetRef;   // ativo que o Vendedor entrega
  quoteAsset: IndexAssetRef;  // ativo que o Comprador entrega
  baseAmount: bigint;         // em unidades mínimas do baseAsset
  maxAgeMs: number;
}

/** Cotação crua de um provedor do motor de swap (preço BRUTO, antes da fee do swap). */
export interface RawQuote {
  provider: string;
  grossOut: bigint;   // saída em unidades mínimas de QUOTE, ANTES da fee de 0,075% do swap
  quoteId?: string;
  expiresAt?: number; // epoch ms; cotação vencida é descartada
}

export interface IndexSource { provider: string; priceE18: bigint; quoteId?: string }
/** Fonte do fixing PERSISTIDA (priceE18 como string — JSON/serialização-safe). */
export interface IndexFixingSource { provider: string; priceE18: string; quoteId?: string }

export interface IndexSnapshot {
  priceE18: bigint;              // mediana (quote por 1 unidade inteira de base, escala 1e18)
  sources: IndexSource[];
  dispersionBps: bigint;         // (max − min) / mediana em bps
  observedAt: number;            // epoch ms
}

/** Fonte do índice. Implementações: VerumSwapIndexProvider (motor real) e MockIndexProvider (dev/teste). */
export interface IndexPriceProvider {
  /** Rótulo opaco da fonte (UI mostra só "Verum Swap", nunca o provedor externo). */
  readonly label: string;
  snapshot(req: IndexRequest): Promise<IndexSnapshot>;
}

export type IndexedPricingMode = 'FIXED' | 'INDEXED_VERUM_SWAP';
export type IndexedPricingStatus = 'CONFIGURED' | 'FIXED' | 'LOCKED' | 'CANCELLED';
export const INDEX_SOURCE = 'VERUM_SWAP' as const;

/** Limites configuráveis do módulo (defaults do §3 da spec). */
export interface IndexedPricingLimits {
  spreadBpsMin: number;        // padrão -500
  spreadBpsMax: number;        // padrão +500
  minProviders: number;        // padrão 2
  maxDispersionBps: number;    // padrão 100 (1%)
  maxMoveBps: number;          // padrão 100
  fixingTtlSec: number;        // padrão 600
  timeoutMs: number;           // padrão 3000
}

export const DEFAULT_INDEXED_LIMITS: IndexedPricingLimits = {
  spreadBpsMin: -500, spreadBpsMax: 500, minProviders: 2, maxDispersionBps: 100, maxMoveBps: 100, fixingTtlSec: 600, timeoutMs: 3000,
};

/** Registro 1:1 com a mesa, VERSIONADO junto com os termos (terms_version cresce a cada refixing pós-lock). */
export interface IndexedPricingRecord {
  mesaId: string;
  termsVersion: number;
  mode: IndexedPricingMode;
  indexSource: typeof INDEX_SOURCE;
  spreadBps: number;
  maxMoveBps: number;
  fixingTtlSec: number;
  status: IndexedPricingStatus;
  /** quantidade do VENDEDOR (base), em unidades mínimas. */
  baseAmount: string | null;
  /** fixing congelado (null até o primeiro fix). */
  fixingPriceE18: string | null;
  fixingSources: IndexFixingSource[] | null;
  fixingDispersionBps: string | null;
  quoteAmount: string | null;
  roundingResidual: string | null;
  fixingHash: string | null;
  fixedAt: number | null;
  fixingExpiresAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** View serializável (bigint→string) para a API/UI. Mesma forma do record (já é string-safe). */
export type IndexedPricingView = IndexedPricingRecord;
