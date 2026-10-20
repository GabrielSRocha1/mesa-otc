/**
 * LightningSwapCoordinator — a mecânica ATÔMICA da rota LIGHTNING_SWAP (perna BTC via Lightning,
 * perna USDT no escrow V2). É o coração de segurança da feature; não reescreve o motor de deals.
 *
 * Invariantes (ambos-ou-nenhum em todos os cenários):
 *  - A preimage R é do COMPRADOR (quem recebe o BTC). A mesa NUNCA a conhece antes do pagamento —
 *    por isso não pode liquidar sem pagar.
 *  - O nó só PAGA a invoice depois que o USDT está FUNDED on-chain (verificado em getDealState).
 *  - Ao pagar, o nó obtém R e só então chama settle(dealId, [], R) — o escrow valida sha256(R)==H.
 *  - Idempotência: já SETTLED/REFUNDED → no-op. Pagamento já feito (lookup) não repaga.
 *  - Se o Comprador nunca revela R (invoice não paga) → nada sai do nó; o USDT volta pelo refund
 *    do contrato após a janela. Fundos do nó limitados ao HTLC em trânsito.
 */
import { sha256Hex } from '../domain/types.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { DomainError } from '../domain/errors.js';
import type { SettlementAdapter } from '../adapters/types.js';
import type { LightningService } from '../adapters/lightning/types.js';

export type SwapOutcome =
  | { status: 'already_settled'; settleTx?: string }
  | { status: 'refunded' }
  | { status: 'awaiting_funding' }          // USDT ainda não travado on-chain → NÃO paga
  | { status: 'payment_failed'; reason?: string }
  | { status: 'settled'; preimage: string; settleTx: string };

export class LightningSwapCoordinator {
  constructor(
    private readonly adapter: SettlementAdapter,  // escrow da perna USDT (evmV2 real ou simulador)
    private readonly ln: LightningService,         // nó LN da mesa (market-maker)
    private readonly legIndex: number,             // índice da leg USDT no commitment
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Precheck de aprovação: o nó tem liquidez outbound para entregar `amountSat`? */
  async hasLiquidity(amountSat: bigint): Promise<{ ok: boolean; outboundSat: bigint }> {
    const bal = await this.ln.getBalance();
    return { ok: bal.outboundSat >= amountSat, outboundSat: bal.outboundSat };
  }

  /**
   * Executa (ou retoma) o swap: paga a invoice SE o USDT estiver travado, e liquida com a preimage
   * revelada. Seguro para re-chamada (watcher/poll) — idempotente em cada estágio.
   */
  async payAndSettle(dealId: string, bolt11: string, htlcHash: string): Promise<SwapOutcome> {
    const H = htlcHash.toLowerCase();
    // 0) Estado terminal on-chain? (idempotência do settle)
    const st0 = await this.adapter.getDealState(dealId);
    if (st0.status === 'SETTLED') return { status: 'already_settled', settleTx: st0.settledTx };
    if (st0.status === 'REFUNDED') return { status: 'refunded' };
    // 1) INVARIANTE DE ATOMICIDADE: só paga o BTC depois do USDT FUNDED on-chain.
    if (st0.status !== 'FUNDED') return { status: 'awaiting_funding' };
    // 2) Pagamento já liquidado antes? (recuperação sem repagar). Senão, paga agora.
    let pay = await this.ln.lookupPayment(H);
    if (pay.status !== 'succeeded') pay = await this.ln.payInvoice(bolt11, { timeoutSec: 60 });
    if (pay.status !== 'succeeded' || !pay.preimage) return { status: 'payment_failed', reason: pay.failureReason };
    // 3) A preimage revelada tem de casar com o hashlock do contrato (defesa em profundidade).
    if (sha256Hex(hexToBytes(pay.preimage)) !== H) throw new DomainError('SETTLEMENT_FAILED', 'preimage revelada na Lightning não corresponde ao htlcHash do escrow');
    // 4) Liquida a perna USDT com a preimage (settleV2 ignora assinaturas — já estão on-chain).
    const tx = await this.adapter.settle(dealId, this.legIndex, [], pay.preimage);
    return { status: 'settled', preimage: pay.preimage, settleTx: tx.ref };
  }

  /**
   * Reembolso: USDT volta ao Comprador quando a operação expira sem o pagamento ter sido feito.
   * O contrato só permite após a janela; o adapter.refund recusa antes (deixa pendente p/ retry).
   */
  async refundIfUnpaid(dealId: string): Promise<{ status: 'refunded' | 'settled' | 'pending' | 'noop'; txRef?: string }> {
    const st = await this.adapter.getDealState(dealId);
    if (st.status === 'SETTLED') return { status: 'settled' };           // já trocou — nada a devolver
    if (st.status === 'REFUNDED') return { status: 'noop' };
    if (st.status !== 'FUNDED' && st.status !== 'REGISTERED') return { status: 'noop' };
    try { const tx = await this.adapter.refund(dealId, this.legIndex); return { status: 'refunded', txRef: tx.ref }; }
    catch { return { status: 'pending' }; }                               // janela ainda aberta → retry depois
  }
}
