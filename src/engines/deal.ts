/**
 * Deal Engine — núcleo agnóstico de cadeia. Cria a Deal, orquestra verificações (ativos → preço → liquidez → rota),
 * congela termos e dealHash, coordena funding/assinaturas e delega a liquidação ao Settlement Engine.
 * Toda transição passa por `transition()`: mapa fechado, expiração síncrona, evento encadeado, auditoria, métrica, lock otimista.
 */
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { computeDealHash, newId, randomHex, sha256Hex, canonicalize, NETWORK_KEY_SCHEME, ROLE_ORDER, SIGNING_ORDER, PRE_SETTLING_EXPIRABLE, TERMINAL_STATES, type Deal, type DealState, type Environment, type Leg, type Participant, type Role, type Terms, type CanonicalAsset, type Network } from '../domain/types.js';

/** Janela rolante por assinante: cada papel tem 5 minutos QUANDO chega a vez dele. */
const SIGNER_WINDOW_MS = 5 * 60 * 1000;
import { DomainError } from '../domain/errors.js';
import { assertTransition, CANCELLABLE_STATES } from '../domain/stateMachine.js';
import { hexToBytes } from '@noble/hashes/utils.js';
/** HTLC: hash SHA-256 dos 32 BYTES da preimage (idêntico a `sha256(abi.encodePacked(bytes32))` no contrato e a OP_SHA256 no script Bitcoin). */
export const htlcHashOf = (preimageHex: string): string => sha256Hex(hexToBytes(preimageHex));
/** Divisão igualitária da comissão em bps; o resíduo de arredondamento vai para o primeiro Pay Master. */
export const splitEqual = (commissionBps: number, n: number): number[] => { if (n <= 0) return []; const base = Math.floor(commissionBps / n); const arr = Array<number>(n).fill(base); arr[0] = (arr[0] ?? 0) + commissionBps - base * n; return arr; };
import type { Store } from '../db/repository.js';
import type { AdapterRegistry, ApprovalSignature, DealCommitment } from '../adapters/types.js';
import type { AssetRegistry } from './assetRegistry.js';
import type { PriceEngine } from './price.js';
import type { LiquidityEngine } from './liquidity.js';
import { RouterEngine } from './router.js';
import type { SignatureEngine, Envelope } from './signature.js';
import type { RiskEngine } from './risk.js';
import type { AuditLog } from '../audit/audit.js';
import type { DealMutator } from './settlement.js';
import { metrics, logger } from '../monitoring/metrics.js';

export const CreateDealInput = z.object({
  assetIn: z.object({ network: z.enum(['bitcoin', 'ethereum', 'solana', 'zcash']), chainId: z.string().min(1), contractOrMint: z.string().nullable() }),
  assetOut: z.object({ network: z.enum(['bitcoin', 'ethereum', 'solana', 'zcash']), chainId: z.string().min(1), contractOrMint: z.string().nullable() }),
  amountInBase: z.string().regex(/^[1-9][0-9]*$/, 'inteiro positivo em unidades base'),
  discountBps: z.number().int().min(0).max(2000).default(0),
  commissionBps: z.number().int().min(0).max(5000).default(0),
  commissionSplitBps: z.array(z.number().int().min(0).max(5000)).max(2).default([]),
  maxSlippageBps: z.number().int().min(1).max(1000).default(50),
  maxPriceDriftBps: z.number().int().min(10).max(1000).default(100),
  expiresInSec: z.number().int().min(900).max(10 * 86400).default(3600), // até 10 dias: cobre a assinatura sequencial (Nº participantes × janela de 5 min)
  participants: z.array(z.object({ role: z.enum(['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2']), network: z.enum(['bitcoin', 'ethereum', 'solana', 'zcash']), chainId: z.string().min(1), address: z.string().min(20).max(120) })).min(3).max(4)
});
export type CreateDealInputT = z.infer<typeof CreateDealInput>;

export interface DealEngineConfig { env: Environment; platformFeeBps: number; paymasterShareBps: number; treasury: string; networkCostUsd: (n: Network) => Promise<string>; execMarginMs: number; defaultExpiresSec: number }
export interface DealEngineDeps { store: Store; registry: AssetRegistry; adapters: AdapterRegistry; price: PriceEngine; liquidity: LiquidityEngine; router: RouterEngine; signature: SignatureEngine; risk: RiskEngine; audit: AuditLog; config: DealEngineConfig; now?: () => number }

export interface DealEventMsg { type: string; dealId: string; state: DealState; at: number; payload: Record<string, unknown> }

export class DealEngine {
  readonly events = new EventEmitter();
  private readonly now: () => number;
  private locks = new Map<string, Promise<unknown>>();
  constructor(private readonly d: DealEngineDeps) { this.now = d.now ?? (() => Date.now()); }

  /* ---------- infraestrutura de transição ---------- */
  /** Serializa operações por Deal no processo (complemento ao lock otimista do store). */
  async withDeal<T>(dealId: string, fn: (deal: Deal) => Promise<T>): Promise<T> {
    const prev = this.locks.get(dealId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => { const deal = await this.d.store.getDeal(dealId); if (!deal) throw new DomainError('DEAL_NOT_FOUND', `Deal ${dealId} não encontrada`); return fn(deal); });
    this.locks.set(dealId, run); try { return await run; } finally { if (this.locks.get(dealId) === run) this.locks.delete(dealId); }
  }
  /** Persistência com evento encadeado + auditoria + emissão. Exposto ao Settlement Engine via mutator(). */
  async persist(deal: Deal, type: string, actor: string, payload: Record<string, unknown> = {}): Promise<void> {
    const expected = deal.version; deal.updatedAt = this.now();
    const last = await this.d.store.lastDealEvent(deal.id); const seq = (last?.seq ?? 0) + 1; const prevHash = last?.hash ?? '0'.repeat(64);
    const hash = sha256Hex(`${prevHash}|${seq}|${type}|${sha256Hex(canonicalize(payload))}|${deal.updatedAt}`);
    await this.d.store.saveDeal(deal, expected); deal.version = expected + 1;
    await this.d.store.appendDealEvent({ seq, dealId: deal.id, type, at: deal.updatedAt, actor, payload, prevHash, hash });
    await this.d.audit.append({ actorType: actor.startsWith('op:') ? 'operator' : actor === 'system' ? 'system' : 'user', actorId: actor, category: `deal.${type}`, dealId: deal.id, payload: { state: deal.state, revision: deal.revision, ...payload } });
    const msg: DealEventMsg = { type, dealId: deal.id, state: deal.state, at: deal.updatedAt, payload }; this.events.emit('deal', msg);
  }
  async transition(deal: Deal, to: DealState, actor: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (PRE_SETTLING_EXPIRABLE.has(deal.state) && this.now() >= deal.expiresAt && to !== 'EXPIRED' && to !== 'CANCELLED' && to !== 'BLOCKED') { await this.expireNow(deal, 'system'); throw new DomainError('DEAL_EXPIRED', 'Deal expirada'); }
    assertTransition(deal.state, to); const from = deal.state; deal.state = to; metrics.transitions.inc({ from, to });
    await this.persist(deal, 'state', actor, { from, to, ...payload }); logger.info({ dealId: deal.id, from, to }, 'transição');
  }

  /* ---------- ordem sequencial de assinatura + janela rolante por assinante ---------- */
  /** Papéis presentes, na ordem obrigatória (Vendedor → PM1 → PM2 → Comprador). */
  private signingOrder(deal: Deal): Role[] { return SIGNING_ORDER.filter(r => deal.participants.some(p => p.role === r)); }
  private hasSigned(deal: Deal, role: Role): boolean { return deal.signatures.some(s => s.role === role && s.revision === deal.revision && s.status === 'valid'); }
  /** Próximo papel que deve assinar (o primeiro da ordem ainda sem assinatura válida). */
  private nextTurn(deal: Deal): Role | null { return this.signingOrder(deal).find(r => !this.hasSigned(deal, r)) ?? null; }
  /** (Re)inicia a vez: define o papel atual e reinicia a janela de 5 min (limitada pelo teto global). */
  private startTurn(deal: Deal): void {
    const next = this.nextTurn(deal);
    deal.turnRole = next;
    deal.turnExpiresAt = next ? Math.min(this.now() + SIGNER_WINDOW_MS, deal.expiresAt) : null;
  }
  /** Vez atual expirou (assinante não assinou dentro dos 5 min dele)? */
  private turnExpired(deal: Deal): boolean { return deal.state === 'AWAITING_SIGNATURES' && deal.turnExpiresAt != null && this.now() >= deal.turnExpiresAt; }

  /* ---------- 1. criação ---------- */
  async create(raw: unknown, actor: string): Promise<Deal> {
    const parsed = CreateDealInput.safeParse(raw); if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Entrada inválida', { issues: parsed.error.issues });
    const input = parsed.data; const roles = input.participants.map(p => p.role);
    if (new Set(roles).size !== roles.length || !roles.includes('SELLER') || !roles.includes('BUYER') || !roles.includes('PAYMASTER_1') || (roles.length === 4 && !roles.includes('PAYMASTER_2'))) throw new DomainError('INVALID_INPUT', 'Composição de participantes inválida (Vendedor, Comprador, 1–2 Pay Masters)');
    const addrs = input.participants.map(p => p.address.toLowerCase()); if (new Set(addrs).size !== addrs.length) throw new DomainError('INVALID_INPUT', 'O mesmo endereço não pode ocupar dois papéis');
    const pmCount = roles.filter(r => r.startsWith('PAYMASTER')).length; const split = input.commissionSplitBps.length ? input.commissionSplitBps : splitEqual(input.commissionBps, pmCount);
    if (split.length !== pmCount) throw new DomainError('INVALID_INPUT', `A distribuição da comissão precisa ter ${pmCount} parcela(s)`);
    if (split.reduce((a, b) => a + b, 0) !== input.commissionBps) throw new DomainError('INVALID_INPUT', 'A distribuição da comissão deve totalizar exatamente a comissão total', { commissionBps: input.commissionBps, split });
    if (input.discountBps + input.commissionBps > 10000) throw new DomainError('INVALID_INPUT', 'Deságio + comissão não podem ultrapassar 100%');
    const assetIn = this.d.registry.resolve(input.assetIn); const assetOut = this.d.registry.resolve(input.assetOut);
    if (assetIn.assetId === assetOut.assetId) throw new DomainError('INVALID_INPUT', 'Ativo de saída deve ser diferente do de entrada');
    const participants: Participant[] = input.participants.map(p => { const a = this.d.adapters.get(p.network); if (!a) throw new DomainError('ADAPTER_UNAVAILABLE', `Rede ${p.network} não suportada`); if (a.chain.chainId !== p.chainId) throw new DomainError('WALLET_INVALID', `chainId ${p.chainId} inválido para ${p.network}`); if (!a.validateAddress(p.address)) throw new DomainError('WALLET_INVALID', `Endereço inválido para ${p.network}: ${p.address}`); return { ...p, keyScheme: NETWORK_KEY_SCHEME[p.network] }; }).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
    const seller = participants.find(p => p.role === 'SELLER') as Participant; const buyer = participants.find(p => p.role === 'BUYER') as Participant;
    if (seller.network !== assetIn.network) throw new DomainError('WALLET_INVALID', 'A carteira do Vendedor precisa estar na rede do ativo de entrada');
    if (buyer.network !== assetOut.network) throw new DomainError('WALLET_INVALID', 'A carteira do Comprador precisa estar na rede do ativo de saída');
    const isCreator = participants.some(p => p.address.toLowerCase() === actor.toLowerCase()); if (!isCreator) throw new DomainError('NOT_PARTICIPANT', 'O criador precisa ser um dos participantes');
    const t = this.now(); const id = newId('OTC');
    // A janela global (→ terms.expiresAt, que entra no hash) deve ser criada grande o
    // suficiente p/ cobrir as assinaturas sequenciais (Nº participantes × 5 min). O piso
    // por-turno abaixo se adapta: cada vez recebe min(5 min, tempo global restante).
    const deal: Deal = { id, version: 1, state: 'DRAFT', revision: 1, terms: null, hash: null, draft: { assetIn, assetOut, amountInBase: input.amountInBase, discountBps: input.discountBps, commissionBps: input.commissionBps, commissionSplitBps: split, maxSlippageBps: input.maxSlippageBps, maxPriceDriftBps: input.maxPriceDriftBps, expiresInSec: input.expiresInSec, participants },
      participants: participants.map(p => ({ ...p, connected: p.address.toLowerCase() === actor.toLowerCase(), fundingRequired: p.role === 'SELLER' || p.role === 'BUYER', funding: p.role === 'SELLER' || p.role === 'BUYER' ? 'PENDING' : 'N/A', riskLevel: 'UNKNOWN' })),
      requiredSignatures: participants.length, validSignatures: 0, signatures: [], settlement: null, refunds: [], risk: null, createdBy: actor, createdAt: t, updatedAt: t, expiresAt: t + input.expiresInSec * 1000, turnRole: null, turnExpiresAt: null, shareToken: randomHex(32), onChain: {} };
    await this.d.store.insertDeal(deal); await this.d.store.appendDealEvent({ seq: 1, dealId: id, type: 'created', at: t, actor, payload: { requiredSignatures: deal.requiredSignatures }, prevHash: '0'.repeat(64), hash: sha256Hex(`created|${id}|${t}`) });
    await this.d.audit.append({ actorType: 'user', actorId: actor, category: 'deal.created', dealId: id, payload: { requiredSignatures: deal.requiredSignatures } });
    const fresh = await this.d.store.getDeal(id) as Deal; await this.transition(fresh, 'CREATED', actor);
    // risco da carteira criadora já na entrada
    const me = fresh.participants.find(p => p.address.toLowerCase() === actor.toLowerCase()) as Deal['participants'][number];
    const r = await this.d.risk.assessWallet(id, me.network, me.address); me.riskLevel = r.level; if (r.decision === 'BLOCK') { await this.block(id, 'Carteira do criador reprovada no screening', 'RS-051 · wallet-screening', 'system'); }
    else await this.persist(fresh, 'wallet.connected', actor, { role: me.role });
    return (await this.d.store.getDeal(id)) as Deal;
  }

  /* ---------- 2. carteiras ---------- */
  async connectWallet(dealId: string, role: Role, address: string, actor: string): Promise<Deal> {
    return this.withDeal(dealId, async deal => {
      this.assertNotTerminal(deal); const p = deal.participants.find(x => x.role === role); if (!p) throw new DomainError('NOT_PARTICIPANT', 'papel inexistente');
      if (p.address.toLowerCase() !== address.toLowerCase() || actor.toLowerCase() !== address.toLowerCase()) throw new DomainError('WALLET_INVALID', 'A carteira conectada não corresponde ao endereço registrado para o papel');
      const r = await this.d.risk.assessWallet(deal.id, p.network, p.address); p.riskLevel = r.level;
      if (r.decision === 'BLOCK') { deal.participants = deal.participants.map(x => x.role === role ? p : x); await this.persist(deal, 'wallet.rejected', actor, { role }); await this.blockInternal(deal, `Carteira do papel ${role} reprovada no screening`, 'RS-051 · wallet-screening', 'system'); return deal; }
      p.connected = true; await this.persist(deal, 'wallet.connected', actor, { role });
      if (deal.state === 'CREATED' && deal.participants.every(x => x.connected)) { await this.transition(deal, 'WALLETS_CONNECTED', 'system'); await this.verifyInternal(deal, 'system'); }
      return deal;
    });
  }

  /* ---------- 3–6. verificação: ativos → preço → liquidez → rota → termos congelados ---------- */
  async verify(dealId: string, actor = 'system'): Promise<Deal> { return this.withDeal(dealId, deal => this.verifyInternal(deal, actor)); }
  private async verifyInternal(deal: Deal, actor: string): Promise<Deal> {
    const end = metrics.verificationSeconds.startTimer(); const dr = deal.draft;
    if (deal.state !== 'WALLETS_CONNECTED' && deal.state !== 'ASSETS_VERIFIED') throw new DomainError('ILLEGAL_TRANSITION', `Verificação não permitida em ${deal.state}`);
    try {
      if (deal.state === 'WALLETS_CONNECTED') {
        for (const a of [dr.assetIn, dr.assetOut]) { this.d.registry.resolve(a); await this.d.registry.verifyOnChain(a, this.d.adapters); }
        const seller = deal.participants.find(p => p.role === 'SELLER') as Participant; const bal = await this.d.adapters.require(dr.assetIn.network).getBalance(seller.address, dr.assetIn);
        if (bal < BigInt(dr.amountInBase)) throw new DomainError('FUNDING_REQUIRED', 'Saldo do Vendedor insuficiente para a quantidade', { balance: bal.toString() });
        await this.transition(deal, 'ASSETS_VERIFIED', actor);
      }
      const snapshot = await this.d.price.quote([dr.assetIn.assetId, dr.assetOut.assetId]);
      if (snapshot.anomaly) { metrics.priceAnomalies.inc(); await this.d.risk.priceAnomaly(deal.id, snapshot.anomalyReasons); throw new DomainError('PRICE_ANOMALY', 'Anomalia de preço entre fontes', { reasons: snapshot.anomalyReasons }); }
      const econ = this.d.price.computeEconomics({ assetIn: dr.assetIn, assetOut: dr.assetOut, amountInBase: dr.amountInBase, snapshot, discountBps: dr.discountBps, commissionBps: dr.commissionBps ?? 0, commissionSplitBps: dr.commissionSplitBps ?? [], platformFeeBps: this.d.config.platformFeeBps, paymasterShareBps: this.d.config.paymasterShareBps, maxSlippageBps: dr.maxSlippageBps, maxPriceDriftBps: dr.maxPriceDriftBps, networkCostUsd: { in: await this.d.config.networkCostUsd(dr.assetIn.network), out: await this.d.config.networkCostUsd(dr.assetOut.network) } });
      const riskDecision = await this.d.risk.assessDeal(deal, Number(econ.pricing.usdValueIn)); if (riskDecision === 'BLOCK') { await this.blockInternal(deal, 'Limite de risco excedido', 'RS-050 · limits', 'system'); throw new DomainError('RISK_BLOCKED', 'Operação bloqueada por limites de risco'); }
      const liq = await this.d.liquidity.assess({ assetIn: dr.assetIn, assetOut: dr.assetOut, sizeUsd: Number(econ.pricing.usdValueIn), maxSlippageBps: dr.maxSlippageBps });
      if (!liq.sufficient) { await this.persist(deal, 'liquidity.insufficient', actor, { reasons: liq.reasons }); throw new DomainError('LIQUIDITY_INSUFFICIENT', liq.reasons.join('; '), { assessment: liq }); }
      const routes = await this.d.router.plan({ assetIn: dr.assetIn, assetOut: dr.assetOut, participants: dr.participants, expiresInSec: Math.max(60, Math.floor((deal.expiresAt - this.now()) / 1000)) }); const route = this.d.router.select(routes);
      const escrowFor = (n: Network) => route.legs.find(l => l.escrowChain === n) as Terms['route']['legs'][number];
      const legs: Leg[] = [
        { index: 0, asset: dr.assetIn, amountBase: dr.amountInBase, from: 'SELLER', to: 'BUYER', escrowChain: dr.assetIn.network, escrowContract: escrowFor(dr.assetIn.network).escrowContract, mode: escrowFor(dr.assetIn.network).mode },
        { index: 1, asset: dr.assetOut, amountBase: econ.amountOutBase, from: 'BUYER', to: 'SELLER', escrowChain: dr.assetOut.network, escrowContract: escrowFor(dr.assetOut.network).escrowContract, mode: escrowFor(dr.assetOut.network).mode }
      ];
      const htlc = route.kind === 'HTLC' ? { preimage: randomHex(32) } : null; // segredo gerado para o Vendedor (leg BTC); exposto só a ele via API
      const terms: Terms = { schemaVersion: 1, environment: this.d.config.env, dealId: deal.id, revision: deal.revision, createdAt: deal.createdAt, expiresAt: deal.expiresAt, participants: dr.participants, requiredSignatures: deal.requiredSignatures, legs, pricing: econ.pricing, route: { routeId: route.routeId, kind: route.kind, legs: route.legs, ...(htlc ? { htlcHash: htlcHashOf(htlc.preimage) } : {}) }, dealNonce: randomHex(16) };
      deal.terms = terms; deal.hash = computeDealHash(terms); (deal as Deal & { htlcPreimage?: string }).htlcPreimage = htlc?.preimage;
      await this.transition(deal, 'LIQUIDITY_VERIFIED', actor, { dealHash: deal.hash.dealHash, routeId: route.routeId, priceSnapshotId: snapshot.id, liquidity: { depthUsd: liq.depthUsd, slippageBps: liq.slippageBps } });
      await this.registerOnChain(deal);
      return deal;
    } finally { end(); }
  }
  private commitment(deal: Deal): DealCommitment { const t = deal.terms as Terms; const h = deal.hash as NonNullable<Deal['hash']>; return { dealId: deal.id, revision: deal.revision, dealHash: h.dealHash, expiresAt: t.expiresAt, participants: t.participants, legs: t.legs, pricingHash: h.pricingHash, routeHash: h.routeHash, domainHash: h.domainHash, dealNonce: t.dealNonce, feeBps: t.pricing.platformFeeBps, treasury: this.d.config.treasury, htlcHash: t.route.htlcHash, terms: t }; }
  private async registerOnChain(deal: Deal): Promise<void> {
    const c = this.commitment(deal);
    for (const chain of new Set(c.legs.map(l => l.escrowChain))) { try { const tx = await this.d.adapters.require(chain).registerDeal(c); deal.onChain[chain] = { registered: true, revision: deal.revision }; await this.persist(deal, 'chain.registered', 'keeper', { chain, tx: tx.ref }); } catch (e) { metrics.adapterErrors.inc({ chain, op: 'register' }); throw e; } }
  }

  /* ---------- 7. abertura para assinaturas ---------- */
  async open(dealId: string, actor: string): Promise<Deal> { return this.withDeal(dealId, async deal => { this.assertCreator(deal, actor); await this.transition(deal, 'AWAITING_SIGNATURES', actor); this.startTurn(deal); await this.persist(deal, 'turn.started', 'system', { turnRole: deal.turnRole, turnExpiresAt: deal.turnExpiresAt }); return deal; }); }

  /* ---------- 8. funding (dev: simulador; prod: indexer reporta) ---------- */
  async fund(dealId: string, role: Role, actor: string): Promise<Deal> {
    return this.withDeal(dealId, async deal => {
      if (deal.state !== 'AWAITING_SIGNATURES') throw new DomainError('SETTLEMENT_NOT_ALLOWED', `Depósito só em AWAITING_SIGNATURES (atual ${deal.state})`);
      const p = deal.participants.find(x => x.role === role); if (!p || !p.fundingRequired) throw new DomainError('NOT_PARTICIPANT', 'papel não deposita');
      if (p.address.toLowerCase() !== actor.toLowerCase()) throw new DomainError('FORBIDDEN', 'só a carteira do papel deposita');
      if (p.funding === 'FINAL') return deal;
      const leg = (deal.terms as Terms).legs[role === 'SELLER' ? 0 : 1] as Leg; const adapter = this.d.adapters.require(leg.escrowChain);
      if (leg.mode === 'HTLC') { const other = deal.participants.find(x => x.fundingRequired && x.role !== role) as Deal['participants'][number]; if (other.funding !== 'FINAL') throw new DomainError('FUNDING_REQUIRED', 'Na rota HTLC a leg de contrato precisa ser financiada primeiro'); }
      try { const tx = await adapter.deposit(deal.id, leg.index, p.address); const st = await adapter.waitFinal(tx.ref); p.funding = st.status === 'final' ? 'FINAL' : 'SEEN'; await this.persist(deal, 'funded', actor, { role, legIndex: leg.index, tx: tx.ref, status: st.status }); }
      catch (e) { metrics.adapterErrors.inc({ chain: leg.escrowChain, op: 'deposit' }); throw e; }
      return deal;
    });
  }

  /* ---------- 9. assinaturas ---------- */
  async envelope(dealId: string, role: Role, actor: string): Promise<Envelope> {
    return this.withDeal(dealId, async deal => { if (deal.state !== 'AWAITING_SIGNATURES') throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Deal não está aguardando assinaturas'); const p = deal.participants.find(x => x.role === role); if (!p || p.address.toLowerCase() !== actor.toLowerCase()) throw new DomainError('FORBIDDEN', 'papel não pertence ao ator'); if (this.now() >= deal.expiresAt) { await this.expireNow(deal, 'system'); throw new DomainError('DEAL_EXPIRED', 'Deal expirada'); } return this.d.signature.envelope(deal, role); });
  }
  async submitSignature(dealId: string, sig: ApprovalSignature, actor: string): Promise<{ deal: Deal; count: number }> {
    return this.withDeal(dealId, async deal => {
      if (sig.signer.toLowerCase() !== actor.toLowerCase()) throw new DomainError('FORBIDDEN', 'assinatura de outra carteira');
      const p = deal.participants.find(x => x.role === sig.role);
      if (!p || p.address.toLowerCase() !== sig.signer.toLowerCase()) { metrics.signaturesRejected.inc({ reason: 'wrong_signer' }); throw new DomainError('SIGNATURE_WRONG_SIGNER', 'carteira não é participante neste papel'); }
      if (p.fundingRequired && p.funding !== 'FINAL') { metrics.signaturesRejected.inc({ reason: 'funding' }); throw new DomainError('FUNDING_REQUIRED', 'Deposite no escrow antes de assinar'); }
      // ORDEM OBRIGATÓRIA: Vendedor → PM1 → PM2 → Comprador. Nenhum papel assina antes dos anteriores.
      const order = this.signingOrder(deal); const idx = order.indexOf(sig.role);
      const pending = order.slice(0, idx).filter(r => !this.hasSigned(deal, r));
      if (pending.length) { metrics.signaturesRejected.inc({ reason: 'out_of_order' }); throw new DomainError('SIGNATURE_OUT_OF_ORDER', `Aguardando assinatura de ${pending[0]} antes de ${sig.role}`); }
      // JANELA POR ASSINANTE: se os 5 min da vez atual estouraram (antes do teto global), a Deal expira.
      // Quando o teto global já venceu, deixa a validação lançar DEAL_EXPIRED (semântica de deal expirada).
      if (this.now() < deal.expiresAt && this.turnExpired(deal)) { metrics.signaturesRejected.inc({ reason: 'turn_expired' }); await this.expireNow(deal, 'system'); throw new DomainError('SIGNATURE_EXPIRED', 'Prazo de 5 minutos desta assinatura expirou'); }
      let envelope: Envelope; try { envelope = await this.d.signature.validateApproval(deal, sig); } catch (e) { metrics.signaturesRejected.inc({ reason: (e as DomainError).code ?? 'invalid' }); if ((e as DomainError).code === 'DEAL_EXPIRED') await this.expireNow(deal, 'system'); throw e; }
      const consumed = await this.d.store.consumeNonce(sig.nonce, this.now()); if (!consumed) throw new DomainError('NONCE_INVALID', 'nonce já utilizado');
      const existing = deal.signatures.find(s => s.role === sig.role && s.revision === deal.revision && s.status === 'valid');
      if (existing) { await this.d.store.updateSignatureStatus(existing.id, 'replaced'); existing.status = 'replaced'; }
      const rec = { id: newId('SG'), dealId: deal.id, revision: deal.revision, role: sig.role, signer: p.address, scheme: sig.scheme, envelopeHash: sha256Hex(envelope.message), signedHash: envelope.payload.dealHash, signature: sig.signature, nonce: sig.nonce, receivedAt: this.now(), status: 'valid' as const };
      await this.d.store.insertSignature(rec); deal.signatures.push(rec); deal.validSignatures = deal.signatures.filter(s => s.revision === deal.revision && s.status === 'valid').length; metrics.signaturesAccepted.inc();
      this.startTurn(deal); // avança a vez para o próximo papel e reinicia a janela de 5 min (null quando todos assinaram)
      await this.persist(deal, 'signature.accepted', actor, { role: sig.role, count: deal.validSignatures, required: deal.requiredSignatures, turnRole: deal.turnRole, turnExpiresAt: deal.turnExpiresAt });
      if (deal.validSignatures === deal.requiredSignatures && deal.participants.every(x => !x.fundingRequired || x.funding === 'FINAL')) { await this.transition(deal, 'FULLY_SIGNED', 'system'); await this.transition(deal, 'SETTLEMENT_VALIDATION', 'system'); this.events.emit('settle', deal.id); }
      return { deal, count: deal.validSignatures };
    });
  }

  /* ---------- 10. revisão de termos (RF-007) ---------- */
  async amend(dealId: string, patch: { discountBps?: number; commissionBps?: number; commissionSplitBps?: number[]; amountInBase?: string; expiresInSec?: number }, actor: string): Promise<Deal> {
    return this.withDeal(dealId, async deal => {
      this.assertCreator(deal, actor); if (!['LIQUIDITY_VERIFIED', 'AWAITING_SIGNATURES'].includes(deal.state)) throw new DomainError('ILLEGAL_TRANSITION', `Edição não permitida em ${deal.state}`);
      return this.superseded(deal, actor, 'terms.changed', patch);
    });
  }
  /** Nova revisão: assinaturas superseded, depósitos devolvidos, hash recalculado após reverificação. Também usado quando rota/preço mudam. */
  private async superseded(deal: Deal, actor: string, reason: string, patch: { discountBps?: number; commissionBps?: number; commissionSplitBps?: number[]; amountInBase?: string; expiresInSec?: number } = {}): Promise<Deal> {
    for (const s of deal.signatures.filter(x => x.revision === deal.revision && x.status === 'valid')) { await this.d.store.updateSignatureStatus(s.id, 'superseded'); s.status = 'superseded'; }
    for (const chain of Object.keys(deal.onChain) as Network[]) { const a = this.d.adapters.require(chain); await a.supersede(deal.id, deal.revision); for (const leg of (deal.terms as Terms).legs.filter(l => l.escrowChain === chain)) { const st = await a.getDealState(deal.id); if (st.deposits[leg.index]) { const tx = await a.refund(deal.id, leg.index); const p = deal.participants.find(x => x.role === leg.from) as Deal['participants'][number]; p.funding = 'PENDING'; deal.refunds.push({ role: leg.from, legIndex: leg.index, status: 'REFUNDED', txRef: tx.ref }); } } }
    deal.validSignatures = 0; deal.revision += 1; deal.onChain = {}; deal.terms = null; deal.hash = null; deal.turnRole = null; deal.turnExpiresAt = null;
    if (patch.discountBps !== undefined) deal.draft.discountBps = patch.discountBps;
    if (patch.commissionBps !== undefined) { const pm = deal.draft.participants.filter(p => p.role.startsWith('PAYMASTER')).length; const split = patch.commissionSplitBps ?? splitEqual(patch.commissionBps, pm); if (split.length !== pm || split.reduce((a, b) => a + b, 0) !== patch.commissionBps) throw new DomainError('INVALID_INPUT', 'Distribuição da comissão inválida'); deal.draft.commissionBps = patch.commissionBps; deal.draft.commissionSplitBps = split; }
    if (patch.amountInBase) deal.draft.amountInBase = patch.amountInBase; if (patch.expiresInSec) { deal.draft.expiresInSec = patch.expiresInSec; deal.expiresAt = this.now() + patch.expiresInSec * 1000; }
    await this.transition(deal, 'ASSETS_VERIFIED', actor, { reason, revision: deal.revision });
    await this.verifyInternal(deal, actor); return deal;
  }

  /* ---------- 11. cancelamento, bloqueio, expiração, reembolso ---------- */
  async cancel(dealId: string, actor: string): Promise<Deal> {
    return this.withDeal(dealId, async deal => {
      if (!deal.participants.some(p => p.address.toLowerCase() === actor.toLowerCase())) throw new DomainError('FORBIDDEN', 'só participantes cancelam');
      if (!CANCELLABLE_STATES.has(deal.state)) throw new DomainError('ILLEGAL_TRANSITION', `Cancelamento não permitido em ${deal.state}`);
      const funded = deal.participants.some(p => p.funding === 'FINAL');
      if (funded) { for (const chain of Object.keys(deal.onChain) as Network[]) await this.d.adapters.require(chain).supersede(deal.id, deal.revision); await this.transition(deal, 'CANCELLED', actor); await this.refundAll(deal, 'keeper', true); }
      else await this.transition(deal, 'CANCELLED', actor);
      return deal;
    });
  }
  async block(dealId: string, reason: string, rule: string, actor: string): Promise<Deal> { return this.withDeal(dealId, deal => this.blockInternal(deal, reason, rule, actor)); }
  /** Versão para uso dentro de um contexto já travado por withDeal (evita deadlock do lock por Deal). */
  private async blockInternal(deal: Deal, reason: string, rule: string, actor: string): Promise<Deal> {
    if (TERMINAL_STATES.has(deal.state) || deal.state === 'BLOCKED') return deal; deal.risk = { reason, rule, at: this.now() }; await this.transition(deal, 'BLOCKED', actor, { reason, rule });
    if (actor !== 'system') await this.d.risk.settlementIncident(deal.id, rule, { reason, actor });
    if (deal.participants.some(p => p.funding === 'FINAL')) { for (const chain of Object.keys(deal.onChain) as Network[]) { try { await this.d.adapters.require(chain).supersede(deal.id, deal.revision); } catch { /* reembolso fica pendente */ } } await this.refundAll(deal, 'keeper', false); }
    return deal;
  }
  /** Varredura de expiração (scheduler) + expiração síncrona. */
  async expireDue(): Promise<string[]> {
    const due = (await this.d.store.listDeals({ states: [...PRE_SETTLING_EXPIRABLE] })).filter(d => d.expiresAt <= this.now() || this.turnExpired(d)); const ids: string[] = [];
    for (const d of due) { await this.withDeal(d.id, async deal => { if (PRE_SETTLING_EXPIRABLE.has(deal.state) && (deal.expiresAt <= this.now() || this.turnExpired(deal))) { await this.expireNow(deal, 'system'); ids.push(deal.id); } }); }
    return ids;
  }
  private async expireNow(deal: Deal, actor: string): Promise<void> {
    if (!PRE_SETTLING_EXPIRABLE.has(deal.state)) return;
    metrics.invariantViolations.inc({ kind: 'expired' }); await this.transition(deal, 'EXPIRED', actor, { validSignatures: deal.validSignatures, required: deal.requiredSignatures });
    if (deal.participants.some(p => p.funding === 'FINAL')) { await this.transition(deal, 'REFUNDING', 'system'); await this.refundAll(deal, 'keeper', false); }
  }
  /** Reembolso permissionless: o keeper relaya; o depositante pode chamar o contrato diretamente (RL-021). */
  private async refundAll(deal: Deal, actor: string, cancelled: boolean): Promise<void> {
    const t = deal.terms; if (!t) return; let allDone = true;
    for (const leg of t.legs) { const p = deal.participants.find(x => x.role === leg.from) as Deal['participants'][number]; if (p.funding !== 'FINAL') continue;
      try { const a = this.d.adapters.require(leg.escrowChain); const tx = await a.refund(deal.id, leg.index); p.funding = 'PENDING'; deal.refunds.push({ role: leg.from, legIndex: leg.index, status: 'REFUNDED', txRef: tx.ref }); await this.persist(deal, 'refunded', actor, { role: leg.from, legIndex: leg.index, tx: tx.ref }); }
      catch (e) { allDone = false; metrics.adapterErrors.inc({ chain: leg.escrowChain, op: 'refund' }); deal.refunds.push({ role: leg.from, legIndex: leg.index, status: 'PENDING', txRef: null }); await this.persist(deal, 'refund.pending', actor, { role: leg.from, error: (e as Error).message }); }
    }
    if (allDone && deal.state === 'REFUNDING') await this.transition(deal, 'REFUNDED', 'system');
    if (allDone && cancelled) logger.info({ dealId: deal.id }, 'depósitos devolvidos após cancelamento');
  }
  /** Reprocessa reembolsos pendentes (recuperação após falha de RPC). */
  async retryRefunds(dealId: string): Promise<Deal> { return this.withDeal(dealId, async deal => { if (deal.state !== 'REFUNDING') return deal; deal.refunds = deal.refunds.filter(r => r.status !== 'PENDING'); await this.refundAll(deal, 'keeper', false); return deal; }); }

  /** Fachada estreita para o Settlement Engine (não expõe criação/assinatura). */
  mutator(): DealMutator { return { withDeal: (id, fn) => this.withDeal(id, fn), transition: (d, to, a, p) => this.transition(d, to, a, p), persist: (d, t, a, p) => this.persist(d, t, a, p), refundAll: (d, a) => this.refundAll(d, a, false) }; }

  /* ---------- helpers ---------- */
  private assertNotTerminal(deal: Deal): void { if (TERMINAL_STATES.has(deal.state) || deal.state === 'BLOCKED') throw new DomainError('DEAL_TERMINAL', `Deal em estado terminal ${deal.state}`); }
  private assertCreator(deal: Deal, actor: string): void { if (deal.createdBy.toLowerCase() !== actor.toLowerCase()) throw new DomainError('FORBIDDEN', 'apenas o criador'); }
  async get(dealId: string): Promise<Deal> { const d = await this.d.store.getDeal(dealId); if (!d) throw new DomainError('DEAL_NOT_FOUND', 'Deal não encontrada'); return d; }
  /** Visão filtrada por papel: participantes veem a Deal; segredo HTLC só para o Vendedor. */
  view(deal: Deal, actor: string | null, operator = false): Record<string, unknown> {
    const me = deal.participants.find(p => actor && p.address.toLowerCase() === actor.toLowerCase());
    if (!me && !operator) throw new DomainError('FORBIDDEN', 'não é participante');
    const { htlcPreimage, ...rest } = deal as Deal & { htlcPreimage?: string };
    return { ...rest, signatures: deal.signatures.map(s => ({ role: s.role, signer: s.signer, status: s.status, receivedAt: s.receivedAt, revision: s.revision })), myRole: me?.role ?? null, ...(me?.role === 'SELLER' && htlcPreimage ? { htlcPreimage } : {}) };
  }
  static assetLabel(a: CanonicalAsset): string { return `${a.code}@${a.network}`; }
}
