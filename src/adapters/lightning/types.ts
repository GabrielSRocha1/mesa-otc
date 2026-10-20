/**
 * Lightning Service — contrato do nó LN da mesa para a rota LIGHTNING_SWAP.
 *
 * A perna BTC do swap é entregue via Lightning, atomicamente acoplada à perna USDT do escrow V2
 * pelo PREIMAGE compartilhado: a invoice do Comprador tem `payment_hash = htlcHash` do deal; ao pagar
 * a invoice, o nó obtém a `r_preimage = preimage`, que destrava o `settleV2` on-chain (sha256 idêntico).
 *
 * Modelo: a MESA é a market-maker de BTC — paga a invoice com a PRÓPRIA liquidez outbound e recebe o
 * USDT no settle. Nunca custodia BTC do cliente; os fundos do nó ficam limitados ao HTLC em trânsito.
 *
 * NÃO é um SettlementAdapter (não é uma rede de escrow indexada por `Network`): é um serviço injetado
 * via AppOverrides, consumido pelo criador da deal, pelo precheck de liquidez e pelo watcher do settle.
 */

/** Invoice BOLT11 emitida/observada. `paymentHash` = sha256(preimage) = htlcHash do deal. */
export interface LnInvoice {
  bolt11: string;
  paymentHash: string;      // hex 32 bytes
  amountSat: bigint;
  expiresAt: number;        // epoch ms
}

/** Resultado de um pagamento Lightning. Em sucesso, `preimage` é o segredo que destrava o settleV2. */
export interface LnPayment {
  status: 'pending' | 'succeeded' | 'failed';
  paymentHash: string;
  preimage: string | null;  // hex 32 bytes quando succeeded
  feeSat: bigint;
  failureReason?: string;
}

export interface LnNodeInfo { pubkey: string; alias: string; chains: string[] }
/** Saldo de canais: `outboundSat` é a liquidez disponível para PAGAR (entregar BTC ao Comprador). */
export interface LnBalance { outboundSat: bigint; inboundSat: bigint }

export interface LightningService {
  /** Info do nó (precheck de conectividade/ambiente). */
  getNodeInfo(): Promise<LnNodeInfo>;
  /** Liquidez de canais — usado no precheck da aprovação (outbound ≥ amount do swap?). */
  getBalance(): Promise<LnBalance>;
  /**
   * Cria uma invoice COM payment_hash FIXO = htlcHash do deal (a preimage é do Comprador; o nó só
   * conhece o hash). No LND isso é `addHoldInvoice`. Usado quando a mesa gera a invoice em nome do
   * fluxo; se o Comprador traz a própria invoice (bolt11), o serviço só a valida (payment_hash==H).
   */
  addInvoice(paymentHash: string, amountSat: bigint, memo: string): Promise<LnInvoice>;
  /** Decodifica/valida um bolt11 trazido pelo Comprador — confirma payment_hash e valor. */
  decodeInvoice(bolt11: string): Promise<LnInvoice>;
  /**
   * Paga a invoice (entrega o BTC ao Comprador). SÓ deve ser chamado após o USDT estar FUNDED on-chain
   * (garantido pelo chamador). Em sucesso devolve a `preimage` revelada pelo recebedor — que o watcher
   * usa no settleV2. Timeout curto; falha nunca move fundos além do HTLC em trânsito.
   */
  payInvoice(bolt11: string, opts?: { timeoutSec?: number; maxFeeSat?: bigint }): Promise<LnPayment>;
  /** Consulta o estado de um pagamento por payment_hash (idempotência / recuperação). */
  lookupPayment(paymentHash: string): Promise<LnPayment>;
  /**
   * SÓ SIMULADOR (preview/dev): gera uma invoice "do Comprador" — preimage aleatória, hash, invoice —
   * para exercitar o fluxo sem um segundo nó LN. No nó REAL é undefined (o Comprador traz a própria).
   */
  simulateBuyerInvoice?(amountSat: bigint, memo: string): Promise<LnInvoice>;
}
