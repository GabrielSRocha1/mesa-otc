/**
 * Pré-pagamento de gás EVM (gas prepayment) — LÓGICA PURA (sem RPC/viem).
 *
 * Regra de negócio: quem está com a perna na rede EVM/ETH banca o gás das operações EVM do keeper
 * (registro + liquidação OU reembolso). A contraparte (BTC/SOL/Tron) só paga a taxa da rede dela.
 *   - cross-chain (1 perna EVM): paga o DONO dessa perna (quem deposita o token na EVM).
 *   - mesma rede (2 pernas EVM): paga o COMPRADOR (regra escolhida pelo produto).
 *
 * `settle` e `refund` são MUTUAMENTE EXCLUSIVOS (a mesa segue um só caminho), então o depósito
 * reserva `registro + o MAIOR entre (settle, refund)` — não os três. O reembolso (mais barato que o
 * settle) fica coberto de sobra; assim, se o pagador sumir, o keeper reembolsa com o que já recebeu.
 * A sobra não usada é devolvida ao pagador no fim; picos de gás além do depósito são cobertos pela
 * taxa de 0,03% (treasury) — ver wiring no DealEngine.
 */
import type { DealCommitment } from '../adapters/types.js';
import type { Role } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';

/** Gás MEDIDO on-chain (Sepolia/mainnet) de cada op EVM do ciclo, com folga sobre o observado. */
export const EVM_GAS_UNITS = {
  register: 1_350_000n, // createTradeV2 (~1,30M medido)
  settle: 260_000n,     // settleV2 (~0,25M medido)
  refund: 220_000n,     // expireAndRefundV2 (~0,21M medido)
} as const;

/** Margem padrão sobre o gás atual (bps; 30000 = 3,0×). Absorve a variação de preço até o settle/refund. */
export const DEFAULT_GAS_PREPAY_MARGIN_BPS = 30_000n;

/** Gás reservado para o ciclo: registro + o PIOR entre liquidar/reembolsar (nunca os dois juntos). */
export function lifecycleGasUnits(): bigint {
  const tail = EVM_GAS_UNITS.settle > EVM_GAS_UNITS.refund ? EVM_GAS_UNITS.settle : EVM_GAS_UNITS.refund;
  return EVM_GAS_UNITS.register + tail;
}

/** Depósito dinâmico em wei = unidades do ciclo × gasPrice atual × margem. */
export function estimateGasPrepayWei(gasPriceWei: bigint, marginBps: bigint = DEFAULT_GAS_PREPAY_MARGIN_BPS): bigint {
  if (gasPriceWei <= 0n) throw new DomainError('INVALID_INPUT', 'gasPrice inválido para estimar o pré-pagamento');
  return (lifecycleGasUnits() * gasPriceWei * marginBps) / 10_000n;
}

/** Papel que banca o gás EVM da mesa (ver regra no topo). Lança se não houver perna EVM. */
export function evmGasPayerRole(c: DealCommitment): Role {
  const evm = c.legs.filter(l => l.escrowChain === 'ethereum');
  if (evm.length === 0) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'deal sem perna EVM — não há gás EVM a pré-pagar');
  if (evm.length >= 2) return 'BUYER'; // mesma rede → comprador paga
  return evm[0]!.from;                 // cross-chain → dono da perna EVM (quem deposita o token)
}

/** Pagador do gás EVM: papel + endereço (o lado-EVM sempre tem endereço EVM nativo — ele deposita o token). */
export function evmGasPayer(c: DealCommitment): { role: Role; address: string } {
  const role = evmGasPayerRole(c);
  const p = c.participants.find(x => x.role === role);
  if (!p) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `pagador do gás (${role}) ausente nos participantes`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.address)) throw new DomainError('SETTLEMENT_NOT_ALLOWED', `pagador do gás (${role}) sem endereço EVM`);
  return { role, address: p.address };
}
