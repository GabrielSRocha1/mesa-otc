/**
 * Plano de liquidação da mesa — derivado dos ativos das cadeiras (nunca escolhido à mão).
 * Três caminhos:
 *  - ESCROW_DIRECT: as duas pernas na MESMA rede suportada pelo escrow (EVM/Tron/Solana) → VerumOtcEscrow.
 *  - HTLC_BTC: um dos lados é BTC NATIVO (rede bitcoin, sem contrato) → atomic swap com hash secret
 *    compartilhado: BTC trancado em HTLC na rede Bitcoin; a outra perna trancada no escrow com o mesmo
 *    sha256(preimage). O claim do token revela a preimage e destrava o BTC.
 *  - CROSS_CHAIN: pernas em redes diferentes (ex.: USDT Polygon ↔ USDT Tron) → escrow na rede de cada
 *    perna + mensagem de liberação atômica via router (Chainlink CCIP; LayerZero como fallback).
 */
import type { MesaChair } from './types.js';

export type SettlementMode = 'ESCROW_DIRECT' | 'HTLC_BTC' | 'CROSS_CHAIN';

export interface SettlementPlan {
  mode: SettlementMode;
  /** Rede onde cada perna é liquidada. */
  sellerNetwork: string;
  buyerNetwork: string;
  /** CROSS_CHAIN: transporte da mensagem de liberação. */
  bridge?: 'CCIP' | 'LAYERZERO';
  /** HTLC_BTC: parâmetros do swap atômico (hash só é gerado na aprovação). */
  htlc?: { hashAlgo: 'sha256'; btcSide: 'SELLER' | 'BUYER'; btcLockBlocks: number; tokenLockSeconds: number };
  /** Resumo nominal em PT-BR para exibição no wizard/detalhe. */
  summary: string;
}

const isNativeBtc = (c: MesaChair): boolean => c.expectedAsset.network === 'bitcoin' && c.expectedAsset.contractOrMint == null;

/**
 * Deriva o plano a partir das cadeiras SELLER/BUYER. Puro e determinístico — entra no termsHash
 * congelado da aprovação, então participante e admin veem exatamente o mesmo caminho.
 */
export function deriveSettlementPlan(chairs: MesaChair[]): SettlementPlan | null {
  const seller = chairs.find(c => c.role === 'SELLER');
  const buyer = chairs.find(c => c.role === 'BUYER');
  if (!seller || !buyer) return null;
  const sellerNetwork = seller.expectedAsset.network;
  const buyerNetwork = buyer.expectedAsset.network;
  if (isNativeBtc(seller) || isNativeBtc(buyer)) {
    const btcSide = isNativeBtc(seller) ? 'SELLER' as const : 'BUYER' as const;
    return {
      mode: 'HTLC_BTC', sellerNetwork, buyerNetwork,
      // BTC fica trancado MAIS tempo que o token (≈24h vs 40min do escrow): quem revela a preimage
      // é o lado token — o lado BTC nunca pode ficar sem janela de resgate após o claim do token.
      htlc: { hashAlgo: 'sha256', btcSide, btcLockBlocks: 144, tokenLockSeconds: 2400 },
      summary: `BTC nativo (${btcSide === 'SELLER' ? 'Vendedor' : 'Comprador'}) via HTLC + ${btcSide === 'SELLER' ? buyerNetwork : sellerNetwork} no escrow — swap atômico com o mesmo hash secret`,
    };
  }
  if (sellerNetwork !== buyerNetwork) {
    return {
      mode: 'CROSS_CHAIN', sellerNetwork, buyerNetwork, bridge: 'CCIP',
      summary: `Pernas em redes diferentes (${sellerNetwork} ↔ ${buyerNetwork}) — escrow em cada rede + liberação atômica via Chainlink CCIP`,
    };
  }
  return { mode: 'ESCROW_DIRECT', sellerNetwork, buyerNetwork, summary: `Liquidação direta no VerumOtcEscrow (${sellerNetwork})` };
}
