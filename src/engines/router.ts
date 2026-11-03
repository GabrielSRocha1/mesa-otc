/**
 * Router Engine — enumera rotas P2P viáveis (ESCROW_NN / HTLC), aplica a restrição de verificabilidade de chaves (R4)
 * e produz Route + routeHash. Determinístico: mesma entrada ⇒ mesma rota. MARKET fica atrás de flag (ADR-002).
 */
import { sha256Hex, canonicalize, type CanonicalAsset, type Participant, type Route, type RouteLegPlan, type Network } from '../domain/types.js';
import type { AdapterRegistry } from '../adapters/types.js';
import { DomainError } from '../domain/errors.js';

export interface RouterConfig { marketRoutesEnabled: boolean; htlcTimelockMarginSec: number }
export const DEFAULT_ROUTER_CONFIG: RouterConfig = { marketRoutesEnabled: false, htlcTimelockMarginSec: 7200 };

export class RouterEngine {
  constructor(private readonly adapters: AdapterRegistry, private readonly cfg: RouterConfig = DEFAULT_ROUTER_CONFIG) {}

  async plan(p: { assetIn: CanonicalAsset; assetOut: CanonicalAsset; participants: Participant[]; expiresInSec: number; netEnv?: 'mainnet' | 'testnet' }): Promise<Route[]> {
    const netEnv = p.netEnv ?? 'testnet';
    const chains: Network[] = [p.assetIn.network, p.assetOut.network]; const schemes = new Set(p.participants.map(x => x.keyScheme));
    const routes: Route[] = []; const notes: string[] = [];
    const legPlans: RouteLegPlan[] = []; let viable = true; let est = 0; let cost = 0; let kind: Route['kind'] = 'ESCROW_NN';
    // Cross-chain token↔token ATÔMICO (ADR-v5): redes diferentes — o lado com HTLC (hashlock)
    // vira a perna HTLC e o outro fica no escrow de contrato; a preimage do settle cruza as
    // redes, sem ponte/coordenador. Vale nas DUAS direções: vendedor-HTLC (ex.: SOL→WETH) ou
    // comprador-HTLC (ex.: WETH→SOL — perna externa do comprador no escrow V2).
    const capOf = (n: Network) => this.adapters.get(n, netEnv)?.capabilities();
    const cross = chains.length === 2 && chains[0] !== chains[1];
    const c0 = cross ? capOf(chains[0] as Network) : undefined;
    const c1 = cross ? capOf(chains[1] as Network) : undefined;
    const htlcSide = cross && c0?.htlc && c0.escrowNN && c1?.escrowNN ? 0
      : cross && c1?.htlc && c1.escrowNN && c0?.escrowNN ? 1
      : -1;
    for (const [i, net] of chains.entries()) {
      const a = this.adapters.get(net, netEnv); if (!a) { viable = false; notes.push(netEnv === 'mainnet' ? `sem adaptador MAINNET para ${net}` : `sem adaptador para ${net}`); continue; }
      const caps = a.capabilities();
      if (caps.htlc && (!caps.escrowNN || htlcSide === i)) { kind = 'HTLC'; legPlans.push({ escrowChain: net, escrowContract: a.escrowAddress(), mode: 'HTLC', fundingOrder: 2, timelockSec: Math.max(60, p.expiresInSec - this.cfg.htlcTimelockMarginSec) }); est += caps.finalityConfirmations * 600; }
      else { legPlans.push({ escrowChain: net, escrowContract: a.escrowAddress(), mode: 'ESCROW_NN', fundingOrder: 1, timelockSec: p.expiresInSec }); est += caps.finalityConfirmations * (net === 'ethereum' ? 400 : 20);
        for (const s of schemes) if (!caps.verifiableSigSchemes.includes(s)) { viable = false; notes.push(`escrow em ${net} não verifica assinaturas ${s} on-chain (todos os participantes precisam de chave verificável)`); } }
      cost += Number(await a.estimateCostUsd('settle')) + Number(await a.estimateCostUsd('deposit'));
      void i;
    }
    if (kind === 'HTLC') { const contractLeg = legPlans.find(l => l.mode === 'ESCROW_NN'); if (!contractLeg) { viable = false; notes.push('HTLC exige uma leg em cadeia com contrato'); } }
    // Perna BTC via Lightning: mesma estrutura de contrato do HTLC (hashlock + leg ESCROW_NN), mas
    // o kind discrimina a ENTREGA (nó LN em vez de cofre P2WSH on-chain) p/ o settlement/deal.
    if (kind === 'HTLC' && legPlans.some(l => l.escrowChain === 'lightning')) kind = 'LIGHTNING_SWAP';
    const route: Route = { routeId: `RT-${kind}-${chains.map(c => c.toUpperCase()).join('-')}`, kind, legs: legPlans, estTimeSec: est, estCostUsd: cost.toFixed(2), viable, note: notes.join('; ') || (kind === 'HTLC' ? 'Leg Bitcoin liquidada por HTLC encadeado ao escrow.' : 'Escrow N-de-N verificado on-chain.') };
    routes.push(route);
    if (this.cfg.marketRoutesEnabled) routes.push({ ...route, routeId: route.routeId.replace('RT-', 'RT-MARKET-'), kind: 'MARKET', viable: false, note: 'Rotas MARKET desabilitadas na v1 (ADR-002).' });
    return routes;
  }
  select(routes: Route[]): Route { const v = routes.filter(r => r.viable); if (v.length === 0) throw new DomainError('ROUTE_NOT_VIABLE', 'Nenhuma rota viável', { notes: routes.map(r => r.note) }); return v.sort((a, b) => Number(a.estCostUsd) - Number(b.estCostUsd))[0] as Route; }
  static hash(r: { routeId: string; kind: string; legs: RouteLegPlan[]; htlcHash?: string }): string { return sha256Hex(canonicalize(r)); }
}
