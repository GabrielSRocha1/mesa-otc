/**
 * Settlement Engine — orquestrador off-chain (arquitetura §7.3/§7.4, §11.4 "double settlement").
 * Regra absoluta: requiredSignatures == validSignatures (uma por papel, revisão corrente) ou NÃO liquida.
 * Idempotente: `settlements.deal_id` é único; um segundo `settle()` para a mesma Deal retorna o registro existente
 * (ou falha com SETTLEMENT_ALREADY_EXECUTED) sem emitir transação. Reconciliação lê o estado on-chain antes de enviar.
 */
import type { Deal, DealState, Leg, SettlementRecord, Terms } from '../domain/types.js';
import { newId, randomHex, PRE_SETTLING_EXPIRABLE } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../db/repository.js';
import type { AdapterRegistry, ApprovalSignature } from '../adapters/types.js';
import type { PriceEngine } from './price.js';
import type { RouterEngine } from './router.js';
import type { RiskEngine } from './risk.js';
import type { SignatureEngine } from './signature.js';
import type { AssetRegistry } from './assetRegistry.js';
import type { AuditLog } from '../audit/audit.js';
import { metrics, logger } from '../monitoring/metrics.js';

export interface SettlementDeps { store: Store; adapters: AdapterRegistry; price: PriceEngine; router: RouterEngine; risk: RiskEngine; signature: SignatureEngine; registry: AssetRegistry; audit: AuditLog; now?: () => number; execMarginMs?: number }
/** Gancho fornecido pelo Deal Engine para transições e persistência sob o lock por Deal. */
export interface DealMutator { withDeal<T>(dealId: string, fn: (deal: Deal) => Promise<T>): Promise<T>; transition(deal: Deal, to: DealState, actor: string, payload?: Record<string, unknown>): Promise<void>; persist(deal: Deal, type: string, actor: string, payload?: Record<string, unknown>): Promise<void>; refundAll(deal: Deal, actor: string): Promise<void> }

export type ValidationCheck = { name: string; ok: boolean; detail?: string };
export interface ValidationReport { ok: boolean; checks: ValidationCheck[]; failCode: 'DEAL_EXPIRED' | 'SETTLEMENT_NOT_ALLOWED' | 'SETTLEMENT_ALREADY_EXECUTED' | 'ROUTE_CHANGED' | 'PRICE_ANOMALY' | 'ASSET_VERIFICATION_FAILED' | 'RISK_BLOCKED' | 'FUNDING_REQUIRED' | 'SIGNATURE_INVALID' | null }

/** Falhas transitórias (RPC/oracle/venue) não bloqueiam a Deal: propagam e a validação é repetida depois. */
export const isTransient = (e: unknown): boolean => e instanceof DomainError && ['ADAPTER_UNAVAILABLE', 'PRICE_UNAVAILABLE', 'LIQUIDITY_UNAVAILABLE'].includes(e.code);

export class SettlementEngine {
  private readonly now: () => number; private readonly execMarginMs: number;
  constructor(private readonly d: SettlementDeps, private readonly deals: DealMutator) { this.now = d.now ?? (() => Date.now()); this.execMarginMs = d.execMarginMs ?? 60_000; }

  /** Verificações obrigatórias (PRD §7.3). Devolve um relatório; só lança em falha transitória (RPC/oracle/venue). */
  async validate(deal: Deal): Promise<ValidationReport> {
    const checks: ValidationCheck[] = []; let failCode: ValidationReport['failCode'] = null;
    const fail = (name: string, code: NonNullable<ValidationReport['failCode']>, detail?: string) => { checks.push({ name, ok: false, detail }); if (!failCode) failCode = code; };
    const pass = (name: string, detail?: string) => checks.push({ name, ok: true, detail });
    const t = deal.terms; const h = deal.hash;
    if (deal.state !== 'SETTLEMENT_VALIDATION') fail('estado', 'SETTLEMENT_NOT_ALLOWED', `estado ${deal.state}`); else pass('estado');
    if (!t || !h) { fail('termos', 'SETTLEMENT_NOT_ALLOWED', 'termos não congelados'); return { ok: false, checks, failCode }; } pass('termos');
    // 2. expiração com margem de execução
    if (this.now() >= t.expiresAt - this.execMarginMs) fail('expiração', 'DEAL_EXPIRED', `restam ${t.expiresAt - this.now()} ms; margem ${this.execMarginMs} ms`); else pass('expiração');
    // 3. hash recomputado dos termos persistidos == hash assinado
    const { computeDealHash } = await import('../domain/types.js'); const recomputed = computeDealHash(t).dealHash;
    if (recomputed !== h.dealHash) fail('dealHash', 'SIGNATURE_INVALID', 'termos persistidos não correspondem ao hash assinado'); else pass('dealHash');
    // 4. N/N assinaturas válidas, uma por papel, todas verificadas criptograficamente de novo
    const valid = deal.signatures.filter(s => s.revision === deal.revision && s.status === 'valid');
    const roles = new Set(valid.map(s => s.role));
    if (valid.length !== deal.requiredSignatures || roles.size !== deal.requiredSignatures || deal.validSignatures !== deal.requiredSignatures) fail('assinaturas', 'SETTLEMENT_NOT_ALLOWED', `${roles.size}/${deal.requiredSignatures}`);
    else { let allOk = true; for (const s of valid) { const r = await this.d.signature.verifyAgainstDeal(deal, { role: s.role, signer: s.signer, scheme: s.scheme, signature: s.signature, nonce: s.nonce }); if (!r.ok || s.signedHash !== h.dealHash) { allOk = false; fail(`assinatura:${s.role}`, 'SIGNATURE_INVALID', r.reason ?? 'hash assinado difere'); } } if (allOk) pass('assinaturas', `${roles.size}/${deal.requiredSignatures}`); }
    // 5. ativos e depósitos
    for (const leg of t.legs) {
      try { await this.d.registry.verifyOnChain(leg.asset, this.d.adapters); pass(`ativo:${leg.index}`); } catch (e) { if (isTransient(e)) throw e; fail(`ativo:${leg.index}`, 'ASSET_VERIFICATION_FAILED', (e as Error).message); }
      const p = deal.participants.find(x => x.role === leg.from); if (!p || p.funding !== 'FINAL') fail(`funding:${leg.index}`, 'FUNDING_REQUIRED', `leg ${leg.index} sem depósito final`); else pass(`funding:${leg.index}`);
    }
    // 6. rota ainda viável e idêntica à assinada
    try {
      const routes = await this.d.router.plan({ assetIn: t.legs[0]!.asset, assetOut: t.legs[1]!.asset, participants: t.participants, expiresInSec: Math.max(60, Math.floor((t.expiresAt - this.now()) / 1000)) });
      const same = routes.find(r => r.routeId === t.route.routeId && r.viable && r.legs.every((l, i) => l.escrowChain === t.route.legs[i]?.escrowChain && l.escrowContract === t.route.legs[i]?.escrowContract && l.mode === t.route.legs[i]?.mode));
      if (!same) fail('rota', 'ROUTE_CHANGED', 'rota assinada não é mais viável ou mudou'); else pass('rota', t.route.routeId);
    } catch (e) { if (isTransient(e)) throw e; fail('rota', 'ROUTE_CHANGED', (e as Error).message); }
    // 7. deriva de preço dentro da banda assinada (ADR-009)
    try {
      const snap = await this.d.price.quote([t.legs[0]!.asset.assetId, t.legs[1]!.asset.assetId]);
      if (snap.anomaly) fail('preço', 'PRICE_ANOMALY', snap.anomalyReasons.join('; '));
      else { const drift = this.d.price.driftBps(t.pricing, snap, t.legs[0]!.asset.assetId, t.legs[1]!.asset.assetId); if (drift > t.pricing.maxPriceDriftBps) fail('preço', 'PRICE_ANOMALY', `deriva ${drift} bps > banda ${t.pricing.maxPriceDriftBps} bps`); else pass('preço', `deriva ${drift} bps`); }
    } catch (e) { if (isTransient(e)) throw e; fail('preço', 'PRICE_ANOMALY', (e as Error).message); }
    // 8. não liquidada on-chain
    for (const chain of new Set(t.legs.map(l => l.escrowChain))) {
      try { const st = await this.d.adapters.require(chain).getDealState(deal.id); if (st.status === 'SETTLED' && st.revision === deal.revision && st.dealHash === h.dealHash) pass(`on-chain:${chain}`, `já liquidada nesta cadeia (${st.settledTx}); será reconciliada`); else if (st.status === 'SETTLED') fail(`on-chain:${chain}`, 'SETTLEMENT_ALREADY_EXECUTED', 'liquidada on-chain com outra revisão/hash'); else if (st.status !== 'FUNDED') fail(`on-chain:${chain}`, 'FUNDING_REQUIRED', `status on-chain ${st.status}`); else if (st.revision !== deal.revision || st.dealHash !== h.dealHash) fail(`on-chain:${chain}`, 'SIGNATURE_INVALID', 'commitment on-chain difere da revisão corrente'); else pass(`on-chain:${chain}`); }
      catch (e) { if (isTransient(e)) throw e; fail(`on-chain:${chain}`, 'SETTLEMENT_NOT_ALLOWED', (e as Error).message); }
    }
    // 9. risco / bloqueio operacional
    if (deal.risk) fail('risco', 'RISK_BLOCKED', deal.risk.reason); else pass('risco');
    const existing = await this.d.store.getSettlement(deal.id); if (existing && existing.status !== 'FAILED') fail('unicidade', 'SETTLEMENT_ALREADY_EXECUTED', `liquidação ${existing.id} já registrada (${existing.status})`); else pass('unicidade');
    return { ok: failCode === null, checks, failCode };
  }

  /**
   * Liquida a Deal. Idempotente: se já existe SettlementRecord DONE/EXECUTING para a Deal, devolve-o sem novas transações.
   * Em falha de leg: BLOCKED + reembolso das legs ainda em escrow (nunca rota alternativa).
   */
  async settle(dealId: string, actor = 'keeper'): Promise<SettlementRecord> {
    return this.deals.withDeal(dealId, async deal => {
      const existing = await this.d.store.getSettlement(deal.id);
      if (existing && (existing.status === 'DONE' || existing.status === 'EXECUTING' || existing.status === 'CONFIRMING')) { metrics.invariantViolations.inc({ kind: 'double_settlement_attempt' }); logger.warn({ dealId }, 'tentativa de liquidação duplicada ignorada'); return existing; }
      if (deal.state === 'SETTLED') { metrics.invariantViolations.inc({ kind: 'double_settlement_attempt' }); throw new DomainError('SETTLEMENT_ALREADY_EXECUTED', 'Deal já liquidada'); }
      if (deal.state !== 'SETTLEMENT_VALIDATION') throw new DomainError('SETTLEMENT_NOT_ALLOWED', `Liquidação só a partir de SETTLEMENT_VALIDATION (atual ${deal.state})`);
      const end = metrics.settlementSeconds.startTimer();
      // Recuperação: se TODAS as cadeias já reportam SETTLED para esta revisão/hash, a verdade é on-chain — apenas reconcilia.
      const reconciled = await this.reconcileAlreadySettled(deal, actor); if (reconciled) { end(); return reconciled; }
      const report = await this.validate(deal);
      await this.deals.persist(deal, 'settlement.validated', actor, { ok: report.ok, checks: report.checks });
      if (!report.ok) {
        if (report.failCode === 'DEAL_EXPIRED') { await this.deals.transition(deal, 'EXPIRED', 'system', { reason: 'expirou durante a validação' }); if (deal.participants.some(p => p.funding === 'FINAL')) { await this.deals.transition(deal, 'REFUNDING', 'system'); await this.deals.refundAll(deal, 'keeper'); } }
        else { metrics.invariantViolations.inc({ kind: report.failCode ?? 'validation' }); deal.risk = deal.risk ?? { reason: report.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail ?? ''}`).join('; '), rule: `7.3 · ${report.failCode}`, at: this.now() }; await this.deals.transition(deal, 'BLOCKED', 'system', { failCode: report.failCode }); await this.d.risk.settlementIncident(deal.id, `7.3 · ${report.failCode}`, { checks: report.checks }); await this.reconcileAndRefund(deal); }
        metrics.settlements.inc({ result: 'rejected' }); end();
        throw new DomainError(report.failCode ?? 'SETTLEMENT_NOT_ALLOWED', 'Liquidação rejeitada: ' + report.checks.filter(c => !c.ok).map(c => c.name).join(', '), { checks: report.checks });
      }
      const t = deal.terms as Terms; const rec: SettlementRecord = { id: newId('ST'), dealId: deal.id, revision: deal.revision, status: 'VALIDATING', lockToken: randomHex(16), startedAt: this.now(), finishedAt: null, idempotencyKey: `${deal.id}:${deal.revision}:${(deal.hash as NonNullable<Deal['hash']>).dealHash}`, legs: t.legs.map(l => ({ index: l.index, step: 'VALIDATED', txRef: null, confirmations: 0 })) };
      const inserted = await this.d.store.insertSettlement(rec);
      if (!inserted) { const cur = await this.d.store.getSettlement(deal.id); if (cur && cur.status !== 'FAILED') { metrics.invariantViolations.inc({ kind: 'double_settlement_attempt' }); return cur; } if (cur) await this.d.store.updateSettlement({ ...rec, id: cur.id }); }
      rec.status = 'EXECUTING'; await this.d.store.updateSettlement(rec); deal.settlement = rec; await this.deals.transition(deal, 'SETTLING', 'system', { settlementId: rec.id });
      const sigs: ApprovalSignature[] = deal.signatures.filter(s => s.revision === deal.revision && s.status === 'valid').map(s => ({ role: s.role, signer: s.signer, scheme: s.scheme, signature: s.signature, nonce: s.nonce }));
      const preimage = (deal as Deal & { htlcPreimage?: string }).htlcPreimage;
      // ordem: legs de contrato primeiro (revelam preimage se HTLC), depois BTC (claim com preimage revelada)
      const order = [...t.legs].sort((a, b) => (a.mode === 'HTLC' ? 1 : 0) - (b.mode === 'HTLC' ? 1 : 0));
      for (const leg of order) {
        const ex = rec.legs.find(l => l.index === leg.index)!; const adapter = this.d.adapters.require(leg.escrowChain);
        try {
          const onChain = await adapter.getDealState(deal.id);
          const doneTx = onChain.settledLegs[leg.index]; if (doneTx) { ex.step = 'FINAL'; ex.txRef = doneTx; ex.confirmations = adapter.capabilities().finalityConfirmations; await this.d.store.updateSettlement(rec); continue; } // recuperação: já enviada antes de uma queda
          const pre = leg.mode === 'HTLC' ? (await this.revealedPreimage(deal, t)) ?? preimage : preimage;
          const tx = await adapter.settle(deal.id, leg.index, sigs, pre); ex.step = 'SUBMITTED'; ex.txRef = tx.ref; await this.d.store.updateSettlement(rec); await this.deals.persist(deal, 'settlement.leg.submitted', actor, { legIndex: leg.index, tx: tx.ref });
          const st = await adapter.waitFinal(tx.ref);
          if (st.status === 'reverted') throw new DomainError('SETTLEMENT_FAILED', `leg ${leg.index} revertida: ${st.error ?? 'reverted'}`, { tx: tx.ref });
          ex.step = st.status === 'final' ? 'FINAL' : 'INCLUDED'; ex.confirmations = st.confirmations; await this.d.store.updateSettlement(rec);
        } catch (e) {
          ex.step = 'FAILED'; ex.error = (e as Error).message; rec.status = 'FAILED'; rec.failureReason = ex.error; rec.finishedAt = this.now(); await this.d.store.updateSettlement(rec); deal.settlement = rec;
          metrics.settlements.inc({ result: 'failed' }); metrics.adapterErrors.inc({ chain: leg.escrowChain, op: 'settle' });
          deal.risk = { reason: `Falha na leg ${leg.index}: ${ex.error}`, rule: 'RL-013 · leg-failure', at: this.now() };
          await this.deals.transition(deal, 'BLOCKED', 'system', { legIndex: leg.index, error: ex.error }); await this.d.risk.settlementIncident(deal.id, 'RL-013 · leg-failure', { legIndex: leg.index, error: ex.error });
          await this.reconcileAndRefund(deal); end();
          throw new DomainError('SETTLEMENT_FAILED', `Falha na liquidação da leg ${leg.index}: ${ex.error}`, { settlementId: rec.id });
        }
      }
      if (rec.legs.every(l => l.step === 'FINAL')) { rec.status = 'DONE'; rec.finishedAt = this.now(); await this.d.store.updateSettlement(rec); deal.settlement = rec; await this.deals.transition(deal, 'SETTLED', 'system', { settlementId: rec.id, txs: rec.legs.map(l => l.txRef) }); metrics.settlements.inc({ result: 'settled' }); }
      else { rec.status = 'CONFIRMING'; await this.d.store.updateSettlement(rec); deal.settlement = rec; await this.deals.persist(deal, 'settlement.confirming', actor, {}); }
      end(); return rec;
    });
  }

  private async reconcileAlreadySettled(deal: Deal, actor: string): Promise<SettlementRecord | null> {
    const t = deal.terms; const h = deal.hash; if (!t || !h) return null; const chains = [...new Set(t.legs.map(l => l.escrowChain))]; const states = new Map<string, Awaited<ReturnType<import('../adapters/types.js').SettlementAdapter['getDealState']>>>();
    for (const c of chains) states.set(c, await this.d.adapters.require(c).getDealState(deal.id));
    if (![...states.values()].every(st => st.status === 'SETTLED' && st.revision === deal.revision && st.dealHash === h.dealHash)) return null;
    const rec: SettlementRecord = { id: newId('ST'), dealId: deal.id, revision: deal.revision, status: 'DONE', lockToken: randomHex(16), startedAt: this.now(), finishedAt: this.now(), idempotencyKey: `${deal.id}:${deal.revision}:${h.dealHash}`, legs: t.legs.map(l => ({ index: l.index, step: 'FINAL' as const, txRef: states.get(l.escrowChain)?.settledLegs[l.index] ?? states.get(l.escrowChain)?.settledTx ?? null, confirmations: this.d.adapters.require(l.escrowChain).capabilities().finalityConfirmations })) };
    const inserted = await this.d.store.insertSettlement(rec); if (!inserted) { const cur = await this.d.store.getSettlement(deal.id); if (cur) { rec.id = cur.id; await this.d.store.updateSettlement(rec); } }
    deal.settlement = rec; await this.deals.transition(deal, 'SETTLING', actor, { reconciled: true }); await this.deals.transition(deal, 'SETTLED', 'system', { settlementId: rec.id, reconciled: true, txs: rec.legs.map(l => l.txRef) });
    metrics.settlements.inc({ result: 'reconciled' }); logger.warn({ dealId: deal.id }, 'liquidação reconciliada a partir do estado on-chain'); return rec;
  }

  /** Após FINAL parcial: legs FINAL permanecem; legs ainda em escrow são devolvidas quando o contrato permitir (expiração/supersede). */
  private async reconcileAndRefund(deal: Deal): Promise<void> {
    const t = deal.terms; if (!t) return;
    for (const leg of t.legs) {
      const adapter = this.d.adapters.get(leg.escrowChain); if (!adapter) continue;
      try { const st = await adapter.getDealState(deal.id); if (st.status === 'SETTLED') continue; if (st.deposits[leg.index]) { await adapter.supersede(deal.id, deal.revision); const tx = await adapter.refund(deal.id, leg.index); const p = deal.participants.find(x => x.role === leg.from); if (p) p.funding = 'PENDING'; deal.refunds.push({ role: leg.from, legIndex: leg.index, status: 'REFUNDED', txRef: tx.ref }); await this.deals.persist(deal, 'refunded', 'keeper', { legIndex: leg.index, tx: tx.ref }); } }
      catch (e) { deal.refunds.push({ role: leg.from, legIndex: leg.index, status: 'PENDING', txRef: null }); await this.deals.persist(deal, 'refund.pending', 'keeper', { legIndex: leg.index, error: (e as Error).message }); }
    }
  }
  private async revealedPreimage(deal: Deal, t: Terms): Promise<string | null> {
    const contractLeg = t.legs.find(l => l.mode !== 'HTLC'); if (!contractLeg) return null;
    try { return await this.d.adapters.require(contractLeg.escrowChain).revealedPreimage(deal.id); } catch { return null; }
  }

  /** Confirmação assíncrona (indexer/keeper): promove legs INCLUDED → FINAL e a Deal → SETTLED. Idempotente. */
  async confirm(dealId: string): Promise<SettlementRecord | null> {
    return this.deals.withDeal(dealId, async deal => {
      const rec = await this.d.store.getSettlement(deal.id); if (!rec || rec.status !== 'CONFIRMING') return rec;
      const t = deal.terms as Terms;
      for (const ex of rec.legs) { if (ex.step === 'FINAL' || !ex.txRef) continue; const leg = t.legs.find(l => l.index === ex.index) as Leg; const st = await this.d.adapters.require(leg.escrowChain).waitFinal(ex.txRef); if (st.status === 'reverted') { ex.step = 'FAILED'; ex.error = st.error; rec.status = 'FAILED'; await this.d.store.updateSettlement(rec); deal.settlement = rec; deal.risk = { reason: `Reorg/reversão na leg ${ex.index}`, rule: 'RS-042 · reorg', at: this.now() }; await this.deals.transition(deal, 'BLOCKED', 'system', { legIndex: ex.index }); await this.reconcileAndRefund(deal); return rec; } if (st.status === 'final') { ex.step = 'FINAL'; ex.confirmations = st.confirmations; } }
      if (rec.legs.every(l => l.step === 'FINAL')) { rec.status = 'DONE'; rec.finishedAt = this.now(); await this.d.store.updateSettlement(rec); deal.settlement = rec; await this.deals.transition(deal, 'SETTLED', 'system', { settlementId: rec.id }); metrics.settlements.inc({ result: 'settled' }); }
      else await this.d.store.updateSettlement(rec);
      return rec;
    });
  }

  /** Recuperação após queda: reconcilia Deals em SETTLEMENT_VALIDATION/SETTLING com o estado on-chain (§13.2). */
  async recover(): Promise<{ dealId: string; action: string }[]> {
    const out: { dealId: string; action: string }[] = [];
    for (const d of await this.d.store.listDeals({ states: ['SETTLEMENT_VALIDATION', 'SETTLING'] })) {
      if (d.state === 'SETTLEMENT_VALIDATION') { if (PRE_SETTLING_EXPIRABLE.has(d.state) && d.expiresAt <= this.now()) { out.push({ dealId: d.id, action: 'expired' }); continue; } try { await this.settle(d.id, 'keeper:recovery'); out.push({ dealId: d.id, action: 'settled' }); } catch (e) { out.push({ dealId: d.id, action: `rejected:${(e as DomainError).code ?? 'error'}` }); } continue; }
      const rec = await this.d.store.getSettlement(d.id);
      if (rec && rec.status === 'CONFIRMING') { await this.confirm(d.id); out.push({ dealId: d.id, action: 'confirmed' }); continue; }
      if (rec && rec.status === 'EXECUTING') {
        // processo caiu durante EXECUTING: retomar leg a leg lendo on-chain; settle() é idempotente por leg (reconhece SETTLED)
        await this.deals.withDeal(d.id, async deal => { rec.status = 'FAILED'; await this.d.store.updateSettlement(rec); deal.state = 'SETTLEMENT_VALIDATION'; await this.deals.persist(deal, 'settlement.recovery', 'keeper', { settlementId: rec.id }); });
        try { await this.settle(d.id, 'keeper:recovery'); out.push({ dealId: d.id, action: 'resumed' }); } catch (e) { out.push({ dealId: d.id, action: `resume-failed:${(e as DomainError).code ?? 'error'}` }); }
      }
    }
    return out;
  }
}
