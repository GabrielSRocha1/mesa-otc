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

export type SettlementMode = 'ESCROW_DIRECT' | 'HTLC_BTC' | 'CROSS_CHAIN' | 'LIGHTNING_SWAP';

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
  // BTC via Lightning: a cadeira do Vendedor é 'lightning' (BTC entregue pelo nó da mesa em segundos),
  // o Comprador paga com token no escrow V2. Mesma estrutura de hashlock do HTLC_BTC, entrega em LN.
  if (seller.expectedAsset.network === 'lightning') {
    return {
      mode: 'LIGHTNING_SWAP', sellerNetwork, buyerNetwork,
      htlc: { hashAlgo: 'sha256', btcSide: 'SELLER', btcLockBlocks: 0, tokenLockSeconds: 2400 },
      summary: `BTC via Lightning (entrega em segundos) ↔ ${buyer.expectedAsset.symbol} no escrow V2 — swap atômico pela preimage da invoice`,
    };
  }
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
    // Swap atômico cross-chain SEM ponte (ADR-v5): vendedor na Solana (SOL NATIVO via
    // htlc_lock_sol ou token SPL) e comprador com TOKEN na rede EVM → perna Solana trancada em
    // HTLC (hashlock sha256) e perna EVM no escrow V2 com o MESMO hash; o settleV2 revela a
    // preimage e destrava a Solana.
    if (sellerNetwork === 'solana' && buyerNetwork === 'ethereum' && buyer.expectedAsset.contractOrMint) {
      return {
        mode: 'CROSS_CHAIN', sellerNetwork, buyerNetwork,
        htlc: { hashAlgo: 'sha256', btcSide: 'SELLER', btcLockBlocks: 0, tokenLockSeconds: 2400 },
        summary: `Swap atômico ${seller.expectedAsset.symbol} (Solana, HTLC${seller.expectedAsset.contractOrMint ? '' : ' nativo'}) ↔ ${buyer.expectedAsset.symbol} (Ethereum, escrow V2) — mesma preimage destrava as duas pernas`,
      };
    }
    // Direção INVERSA (perna externa do COMPRADOR no escrow V2): vendedor com TOKEN na EVM
    // deposita no escrow; o comprador tranca o PAGAMENTO (SOL nativo ou SPL) em HTLC na Solana
    // com o MESMO sha256 — o settleV2 entrega o token ao comprador e revela a preimage que
    // destrava o pagamento para o vendedor lá.
    if (sellerNetwork === 'ethereum' && buyerNetwork === 'solana' && seller.expectedAsset.contractOrMint) {
      return {
        mode: 'CROSS_CHAIN', sellerNetwork, buyerNetwork,
        htlc: { hashAlgo: 'sha256', btcSide: 'BUYER', btcLockBlocks: 0, tokenLockSeconds: 2400 },
        summary: `Swap atômico ${seller.expectedAsset.symbol} (Ethereum, escrow V2) ↔ ${buyer.expectedAsset.symbol} (Solana, HTLC${buyer.expectedAsset.contractOrMint ? '' : ' nativo'}) — o comprador tranca o pagamento e a preimage do settle o destrava`,
      };
    }
    return {
      mode: 'CROSS_CHAIN', sellerNetwork, buyerNetwork, bridge: 'CCIP',
      summary: `Pernas em redes diferentes (${sellerNetwork} ↔ ${buyerNetwork}) — escrow em cada rede + liberação atômica via Chainlink CCIP (pendente)`,
    };
  }
  return { mode: 'ESCROW_DIRECT', sellerNetwork, buyerNetwork, summary: `Liquidação direta no VerumOtcEscrow (${sellerNetwork})` };
}
