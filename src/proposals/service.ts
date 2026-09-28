/**
 * Propostas estruturadas de alteração de termos (VERUM OTC §5.3 / §6).
 *
 * Dentro da mesa, os termos só mudam por PROPOSTAS TIPADAS e validadas (nunca texto livre),
 * o que corta phishing. Aplicar uma proposta aciona o `amend` da máquina de estados já congelada:
 * version++ → todas as assinaturas viram `superseded` → depósitos devolvidos → hash recalculado →
 * a operação retorna a AWAITING_SIGNATURES para reassinatura. Tudo auditado e notificado.
 *
 * Este serviço NÃO reimplementa a invalidação (isso é do DealEngine); ele é a porta de entrada
 * estruturada, com preview do impacto e ciclo de vida (abrir/aplicar/retirar/rejeitar/obsoleta).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import type { DealEngine } from '../engines/deal.js';
import type { Deal } from '../domain/types.js';

/** Mudança estruturada — união discriminada, `strict` (rejeita campos extras e tipos desconhecidos). */
export const ProposalChangeZ = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discount'), discountBps: z.number().int().min(0).max(2000) }).strict(),
  z.object({ type: z.literal('commission'), commissionBps: z.number().int().min(0).max(5000), commissionSplitBps: z.array(z.number().int().min(0)).max(2).optional() }).strict(),
  z.object({ type: z.literal('amount'), amountInBase: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  z.object({ type: z.literal('expiry'), expiresInSec: z.number().int().min(900).max(10 * 86400) }).strict(),
]);
export type ProposalChange = z.infer<typeof ProposalChangeZ>;

export type ProposalStatus = 'open' | 'applied' | 'withdrawn' | 'rejected' | 'stale';
export interface Proposal { id: string; dealId: string; revision: number; proposer: string; change: ProposalChange; status: ProposalStatus; createdAt: number; decidedAt: number | null; decidedBy: string | null }

export interface ProposalPreview {
  diff: { field: string; from: unknown; to: unknown };
  currentRevision: number; nextRevision: number;
  signaturesToInvalidate: number;
  effect: string;
}

export interface ProposalAudit { append(e: { actorType: 'user' | 'system'; actorId: string; category: string; dealId: string | null; payload: Record<string, unknown> }): Promise<unknown> }
export interface ProposalNotifier { notify(dealId: string): void }
export interface ProposalDeps { deals: DealEngine; now?: () => number; audit?: ProposalAudit; notifier?: ProposalNotifier }

const AMENDABLE_STATES = ['LIQUIDITY_VERIFIED', 'AWAITING_SIGNATURES'];

export class ProposalService {
  private byId = new Map<string, Proposal>();
  private byDeal = new Map<string, string[]>();
  private readonly deals: DealEngine;
  private readonly now: () => number;
  private readonly audit?: ProposalAudit;
  private readonly notifier?: ProposalNotifier;
  constructor(deps: ProposalDeps) { this.deals = deps.deals; this.now = deps.now ?? (() => Date.now()); this.audit = deps.audit; this.notifier = deps.notifier; }

  private patchOf(change: ProposalChange): { discountBps?: number; commissionBps?: number; commissionSplitBps?: number[]; amountInBase?: string; expiresInSec?: number } {
    switch (change.type) {
      case 'discount': return { discountBps: change.discountBps };
      case 'commission': return change.commissionSplitBps ? { commissionBps: change.commissionBps, commissionSplitBps: change.commissionSplitBps } : { commissionBps: change.commissionBps };
      case 'amount': return { amountInBase: change.amountInBase };
      case 'expiry': return { expiresInSec: change.expiresInSec };
    }
  }
  private isParticipant(deal: Deal, actor: string): boolean { return deal.participants.some(p => p.address.toLowerCase() === actor.toLowerCase()); }
  private validSignatures(deal: Deal): number { return deal.signatures.filter(s => s.revision === deal.revision && s.status === 'valid').length; }

  private preview(deal: Deal, change: ProposalChange): ProposalPreview {
    const d = deal.draft;
    const diff = change.type === 'discount' ? { field: 'discountBps', from: d.discountBps, to: change.discountBps }
      : change.type === 'commission' ? { field: 'commissionBps', from: d.commissionBps, to: change.commissionBps }
        : change.type === 'amount' ? { field: 'amountInBase', from: d.amountInBase, to: change.amountInBase }
          : { field: 'expiresInSec', from: d.expiresInSec, to: change.expiresInSec };
    return { diff, currentRevision: deal.revision, nextRevision: deal.revision + 1, signaturesToInvalidate: this.validSignatures(deal), effect: 'Todas as assinaturas válidas serão invalidadas; a operação retorna a AWAITING_SIGNATURES para reassinatura.' };
  }
  private view(p: Proposal): Proposal { return { ...p }; }

  /** Cria uma proposta estruturada (qualquer participante). Não altera nada ainda. */
  async propose(dealId: string, actor: string, change: ProposalChange): Promise<{ proposal: Proposal; preview: ProposalPreview }> {
    const deal = await this.deals.get(dealId);
    if (!this.isParticipant(deal, actor)) throw new DomainError('NOT_PARTICIPANT', 'Apenas participantes propõem alterações');
    if (!AMENDABLE_STATES.includes(deal.state)) throw new DomainError('ILLEGAL_TRANSITION', `Alteração de termos não permitida em ${deal.state}`);
    const proposal: Proposal = { id: 'prop_' + randomUUID(), dealId, revision: deal.revision, proposer: actor, change, status: 'open', createdAt: this.now(), decidedAt: null, decidedBy: null };
    this.byId.set(proposal.id, proposal);
    this.byDeal.set(dealId, [...(this.byDeal.get(dealId) ?? []), proposal.id]);
    void this.audit?.append({ actorType: 'user', actorId: actor, category: 'terms.proposal.created', dealId, payload: { type: change.type, revision: deal.revision } });
    this.notifier?.notify(dealId);
    return { proposal: this.view(proposal), preview: this.preview(deal, change) };
  }

  /** Lista as propostas de uma operação (só participantes). */
  async list(dealId: string, actor: string): Promise<Proposal[]> {
    const deal = await this.deals.get(dealId);
    if (!this.isParticipant(deal, actor)) throw new DomainError('NOT_PARTICIPANT', 'Apenas participantes');
    return (this.byDeal.get(dealId) ?? []).map(id => this.byId.get(id)).filter((p): p is Proposal => !!p).map(p => this.view(p));
  }

  private get(dealId: string, proposalId: string): Proposal {
    const p = this.byId.get(proposalId);
    if (!p || p.dealId !== dealId) throw new DomainError('DEAL_NOT_FOUND', 'Proposta inexistente');
    return p;
  }

  /**
   * Aplica a proposta: aciona o `amend` (que exige ser o criador da Deal) e reabre para reassinatura.
   * Marca as demais propostas abertas como obsoletas (baseavam-se na revisão anterior).
   */
  async apply(dealId: string, proposalId: string, actor: string): Promise<Deal> {
    const p = this.get(dealId, proposalId);
    if (p.status !== 'open') throw new DomainError('VERSION_CONFLICT', `Proposta não está aberta (${p.status})`);
    const deal = await this.deals.get(dealId);
    if (p.revision !== deal.revision) { p.status = 'stale'; throw new DomainError('VERSION_CONFLICT', 'Proposta baseada em revisão antiga'); }
    // amend valida ser o criador da Deal (assertCreator) e invalida assinaturas/reverifica (version++).
    await this.deals.amend(dealId, this.patchOf(p.change), actor);
    // Reabre para reassinatura → AWAITING_SIGNATURES (a máquina de estados passa por LIQUIDITY_VERIFIED no amend).
    const reopened = await this.deals.open(dealId, actor);
    p.status = 'applied'; p.decidedAt = this.now(); p.decidedBy = actor;
    for (const id of this.byDeal.get(dealId) ?? []) { const q = this.byId.get(id); if (q && q.status === 'open' && q.id !== p.id) q.status = 'stale'; }
    void this.audit?.append({ actorType: 'user', actorId: actor, category: 'terms.proposal.applied', dealId, payload: { type: p.change.type, revision: reopened.revision } });
    this.notifier?.notify(dealId);
    return reopened;
  }

  /** O proponente retira a própria proposta. */
  async withdraw(dealId: string, proposalId: string, actor: string): Promise<Proposal> {
    const p = this.get(dealId, proposalId);
    if (p.proposer.toLowerCase() !== actor.toLowerCase()) throw new DomainError('FORBIDDEN', 'Apenas o proponente retira');
    if (p.status !== 'open') throw new DomainError('VERSION_CONFLICT', `Proposta não está aberta (${p.status})`);
    p.status = 'withdrawn'; p.decidedAt = this.now(); p.decidedBy = actor;
    void this.audit?.append({ actorType: 'user', actorId: actor, category: 'terms.proposal.withdrawn', dealId, payload: {} });
    return this.view(p);
  }

  /** Um participante registra rejeição de uma proposta aberta. */
  async reject(dealId: string, proposalId: string, actor: string): Promise<Proposal> {
    const deal = await this.deals.get(dealId);
    if (!this.isParticipant(deal, actor)) throw new DomainError('NOT_PARTICIPANT', 'Apenas participantes');
    const p = this.get(dealId, proposalId);
    if (p.status !== 'open') throw new DomainError('VERSION_CONFLICT', `Proposta não está aberta (${p.status})`);
    p.status = 'rejected'; p.decidedAt = this.now(); p.decidedBy = actor;
    void this.audit?.append({ actorType: 'user', actorId: actor, category: 'terms.proposal.rejected', dealId, payload: {} });
    this.notifier?.notify(dealId);
    return this.view(p);
  }
}
