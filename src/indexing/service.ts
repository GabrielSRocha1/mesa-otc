/**
 * Operar Indexado — serviço de fixing (off-chain, termina ANTES das assinaturas). ADITIVO: não altera
 * o fluxo FIXED. Congela o preço indexado em valores CONCRETOS (baseAmount/quoteAmount), registra o
 * fixing versionado + hash + auditoria append-only, e devolve os valores para o fluxo normal da mesa.
 * Falha SEMPRE fechado: sem índice confiável não há fixing e a mesa não avança para assinaturas.
 */
import { DomainError } from '../domain/errors.js';
import { sha256Hex, canonicalize } from '../domain/types.js';
import type { AuditLog } from '../audit/audit.js';
import type { Store } from '../db/repository.js';
import type { MesaChair, MesaRecord } from '../mesa/types.js';
import { applySpreadE18, computeQuoteAmount, BPS } from './math.js';
import type { IndexAssetRef, IndexedPricingLimits, IndexedPricingRecord, IndexPriceProvider } from './types.js';
import { DEFAULT_INDEXED_LIMITS, INDEX_SOURCE } from './types.js';

export interface IndexedPricingDeps {
  store: Store;
  audit: AuditLog;
  /** null = modo indexado DESLIGADO neste ambiente (sem URL do motor em prod). */
  provider: IndexPriceProvider | null;
  limits?: Partial<IndexedPricingLimits>;
  now?: () => number;
}

export interface ConfigureInput { spreadBps: number; baseAmount?: string }
export interface FixInput { confirmMove?: boolean }
/** Resultado do fix: o record + os valores a gravar na config da mesa (perna base/quote concretas). */
export interface FixResult { record: IndexedPricingRecord; baseAmount: string; quoteAmount: string }

const assetRefOf = (chair: MesaChair): IndexAssetRef => ({ network: chair.expectedAsset.network, chainId: null, contractOrMint: chair.expectedAsset.contractOrMint, decimals: chair.expectedAsset.decimals, symbol: chair.expectedAsset.symbol });

export class IndexedPricingService {
  private readonly now: () => number;
  private readonly limits: IndexedPricingLimits;
  constructor(private readonly d: IndexedPricingDeps) {
    this.now = d.now ?? (() => Date.now());
    this.limits = { ...DEFAULT_INDEXED_LIMITS, ...(d.limits ?? {}) };
  }

  /** Está habilitado neste ambiente? (UI usa para mostrar o motivo quando desligado.) */
  get enabled(): boolean { return this.d.provider !== null; }
  getLimits(): IndexedPricingLimits { return { ...this.limits }; }

  async get(mesaId: string): Promise<IndexedPricingRecord | null> { return this.d.store.getIndexedPricing(mesaId); }

  private sellerBuyer(mesa: MesaRecord): { seller: MesaChair; buyer: MesaChair } {
    const seller = mesa.chairs.find(c => c.role === 'SELLER'); const buyer = mesa.chairs.find(c => c.role === 'BUYER');
    if (!seller || !buyer) throw new DomainError('INVALID_INPUT', 'Mesa sem Vendedor/Comprador');
    return { seller, buyer };
  }

  /** Configura o modo INDEXADO + spread (opcionalmente o valor-base). Só o admin chama (gate na rota). */
  async configure(mesa: MesaRecord, input: ConfigureInput, actorId: string): Promise<IndexedPricingRecord> {
    if (!Number.isInteger(input.spreadBps) || input.spreadBps < this.limits.spreadBpsMin || input.spreadBps > this.limits.spreadBpsMax) {
      throw new DomainError('INVALID_INPUT', `Spread fora do intervalo permitido (${this.limits.spreadBpsMin}..${this.limits.spreadBpsMax} bps)`);
    }
    if (input.baseAmount !== undefined && !/^[1-9][0-9]*$/.test(input.baseAmount)) throw new DomainError('INVALID_INPUT', 'Valor-base inválido');
    this.sellerBuyer(mesa); // valida composição cedo
    const cur = await this.d.store.getIndexedPricing(mesa.mesaId);
    const t = this.now();
    // Record travado (pós-aprovação) é imutável → nova versão. Senão, atualiza a versão corrente.
    const base: IndexedPricingRecord = cur && cur.status !== 'LOCKED'
      ? { ...cur }
      : { mesaId: mesa.mesaId, termsVersion: (cur?.termsVersion ?? 0) + 1, mode: 'INDEXED_VERUM_SWAP', indexSource: INDEX_SOURCE, spreadBps: 0, maxMoveBps: this.limits.maxMoveBps, fixingTtlSec: this.limits.fixingTtlSec, status: 'CONFIGURED', baseAmount: null, fixingPriceE18: null, fixingSources: null, fixingDispersionBps: null, quoteAmount: null, roundingResidual: null, fixingHash: null, fixedAt: null, fixingExpiresAt: null, createdBy: actorId, createdAt: t, updatedAt: t };
    const next: IndexedPricingRecord = { ...base, mode: 'INDEXED_VERUM_SWAP', spreadBps: input.spreadBps, status: 'CONFIGURED', baseAmount: input.baseAmount ?? base.baseAmount ?? mesa.config?.amountInBase ?? null, updatedAt: t,
      // reconfigurar invalida o fixing anterior (novo spread ⇒ novos valores a fixar)
      fixingPriceE18: null, fixingSources: null, fixingDispersionBps: null, quoteAmount: null, roundingResidual: null, fixingHash: null, fixedAt: null, fixingExpiresAt: null };
    await this.d.store.upsertIndexedPricing(next);
    await this.d.audit.append({ actorType: 'user', actorId, category: 'mesa.indexed.configurado', dealId: null, payload: { mesaId: mesa.mesaId, termsVersion: next.termsVersion, spreadBps: next.spreadBps, baseAmount: next.baseAmount } });
    return next;
  }

  /** Fixa (ou refixa) o preço indexado em valores concretos. Exige índice confiável (senão falha fechado). */
  async fix(mesa: MesaRecord, input: FixInput, actorId: string): Promise<FixResult> {
    if (!this.d.provider) throw new DomainError('INDEX_DISABLED', 'Modo indexado indisponível neste ambiente (motor de swap não configurado)');
    let cur = await this.d.store.getIndexedPricing(mesa.mesaId);
    if (!cur || cur.mode !== 'INDEXED_VERUM_SWAP') throw new DomainError('INVALID_INPUT', 'Configure o modo indexado antes de fixar o preço');
    const prevFixing = cur.fixingPriceE18 ? BigInt(cur.fixingPriceE18) : null;
    // Refix após LOCK (pós-aprovação): nova versão herdando a configuração (spread/limites/base).
    if (cur.status === 'LOCKED') {
      const t0 = this.now();
      cur = { ...cur, termsVersion: cur.termsVersion + 1, status: 'CONFIGURED', fixingPriceE18: null, fixingSources: null, fixingDispersionBps: null, quoteAmount: null, roundingResidual: null, fixingHash: null, fixedAt: null, fixingExpiresAt: null, updatedAt: t0 };
    }
    const { seller, buyer } = this.sellerBuyer(mesa);
    const baseAmountStr = cur.baseAmount ?? mesa.config?.amountInBase ?? null;
    if (!baseAmountStr || !/^[1-9][0-9]*$/.test(baseAmountStr)) throw new DomainError('INVALID_INPUT', 'Defina o valor-base (quantidade do Vendedor) antes de fixar');
    const baseAmount = BigInt(baseAmountStr);
    const snapshot = await this.d.provider.snapshot({ baseAsset: assetRefOf(seller), quoteAsset: assetRefOf(buyer), baseAmount, maxAgeMs: cur.fixingTtlSec * 1000 });
    const priceFinalE18 = applySpreadE18(snapshot.priceE18, cur.spreadBps);
    const { quoteAmount, residual } = computeQuoteAmount(baseAmount, priceFinalE18, seller.expectedAsset.decimals, buyer.expectedAsset.decimals);
    // Re-fixing com desvio > maxMoveBps do fixing anterior exige confirmação explícita do admin.
    if (prevFixing && prevFixing > 0n) {
      const moveBps = (abs(priceFinalE18 - prevFixing) * BPS) / prevFixing;
      if (moveBps > BigInt(cur.maxMoveBps) && !input.confirmMove) {
        throw new DomainError('INDEX_MOVE_CONFIRM', `Novo preço diverge ${moveBps} bps do fixing anterior (limite ${cur.maxMoveBps} bps) — confirme para prosseguir`, { moveBps: moveBps.toString(), maxMoveBps: cur.maxMoveBps, previousPriceE18: prevFixing.toString(), newPriceE18: priceFinalE18.toString(), previousQuoteAmount: cur.quoteAmount, newQuoteAmount: quoteAmount.toString() });
      }
    }
    const t = this.now();
    const fixingExpiresAt = t + cur.fixingTtlSec * 1000;
    // JSON canônico do fixing → SHA-256. Qualquer campo que mude altera o hash (e invalida assinaturas).
    const fixingBody = { mesaId: mesa.mesaId, termsVersion: cur.termsVersion, indexSource: INDEX_SOURCE, spreadBps: cur.spreadBps, baseAsset: assetRefOf(seller), quoteAsset: assetRefOf(buyer), baseAmount: baseAmount.toString(), referencePriceE18: snapshot.priceE18.toString(), priceFinalE18: priceFinalE18.toString(), quoteAmount: quoteAmount.toString(), roundingResidual: residual.toString(), dispersionBps: snapshot.dispersionBps.toString(), sources: snapshot.sources.map(s => ({ provider: s.provider, priceE18: s.priceE18.toString(), quoteId: s.quoteId ?? null })), observedAt: snapshot.observedAt, fixingExpiresAt };
    const fixingHash = sha256Hex(canonicalize(fixingBody));
    const record: IndexedPricingRecord = { ...cur, status: 'FIXED', baseAmount: baseAmount.toString(), fixingPriceE18: priceFinalE18.toString(), fixingSources: snapshot.sources.map(s => ({ provider: s.provider, priceE18: s.priceE18.toString(), ...(s.quoteId ? { quoteId: s.quoteId } : {}) })), fixingDispersionBps: snapshot.dispersionBps.toString(), quoteAmount: quoteAmount.toString(), roundingResidual: residual.toString(), fixingHash, fixedAt: t, fixingExpiresAt, updatedAt: t };
    await this.d.store.upsertIndexedPricing(record);
    await this.d.audit.append({ actorType: 'user', actorId, category: prevFixing ? 'mesa.indexed.refixado' : 'mesa.indexed.fixado', dealId: null, payload: { mesaId: mesa.mesaId, termsVersion: record.termsVersion, spreadBps: record.spreadBps, baseAmount: record.baseAmount, quoteAmount, dispersionBps: snapshot.dispersionBps.toString(), fixingHash } });
    return { record, baseAmount: baseAmount.toString(), quoteAmount: quoteAmount.toString() };
  }

  /** Remove o modo indexado (volta a FIXED) ANTES das assinaturas. Record travado não pode ser removido. */
  async remove(mesa: MesaRecord, actorId: string): Promise<void> {
    const cur = await this.d.store.getIndexedPricing(mesa.mesaId);
    if (!cur) return;
    if (cur.status === 'LOCKED') throw new DomainError('VERSION_CONFLICT', 'Fixing já travado na aprovação — reabra a operação para editar');
    await this.d.store.deleteIndexedPricing(mesa.mesaId, cur.termsVersion);
    await this.d.audit.append({ actorType: 'user', actorId, category: 'mesa.indexed.removido', dealId: null, payload: { mesaId: mesa.mesaId, termsVersion: cur.termsVersion } });
  }

  /**
   * Revalida o fixing e TRAVA (LOCKED) no momento de LIBERAR ASSINATURAS (approve). Devolve o fixingHash
   * para entrar no deal (terms.pricing). Retorna null quando a mesa está em FIXED (sem modo indexado).
   */
  async lockForApproval(mesa: MesaRecord, actorId: string): Promise<string | null> {
    const cur = await this.d.store.getIndexedPricing(mesa.mesaId);
    if (!cur || cur.mode !== 'INDEXED_VERUM_SWAP') return null; // FIXED: nada a travar
    if (cur.status === 'LOCKED' && cur.fixingHash) return cur.fixingHash; // idempotente (reaprovação)
    if (cur.status !== 'FIXED' || !cur.fixingHash || !cur.quoteAmount || !cur.baseAmount) throw new DomainError('INDEX_NOT_FIXED', 'Preço indexado não foi fixado — fixe o preço antes de aprovar');
    if (cur.fixingExpiresAt != null && this.now() >= cur.fixingExpiresAt) throw new DomainError('INDEX_FIXING_EXPIRED', 'Fixing expirado — fixe o preço novamente antes de aprovar');
    // Integridade: a config congelada precisa refletir EXATAMENTE os valores do fixing (senão alguém
    // alterou amountInBase/buyerAmountInBase à mão entre o fix e o approve → exige novo fixing).
    if (mesa.config?.amountInBase !== cur.baseAmount || mesa.config?.buyerAmountInBase !== cur.quoteAmount) {
      throw new DomainError('INDEX_NOT_FIXED', 'Configuração divergente do fixing — fixe o preço novamente', { expected: { amountInBase: cur.baseAmount, buyerAmountInBase: cur.quoteAmount }, config: { amountInBase: mesa.config?.amountInBase ?? null, buyerAmountInBase: mesa.config?.buyerAmountInBase ?? null } });
    }
    const locked: IndexedPricingRecord = { ...cur, status: 'LOCKED', updatedAt: this.now() };
    await this.d.store.upsertIndexedPricing(locked);
    await this.d.audit.append({ actorType: 'user', actorId, category: 'mesa.indexed.travado', dealId: null, payload: { mesaId: mesa.mesaId, termsVersion: locked.termsVersion, fixingHash: locked.fixingHash } });
    return locked.fixingHash as string;
  }
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);
