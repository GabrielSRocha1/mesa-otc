/** Lógica pura do pré-pagamento de gás EVM: pagador (lado-EVM) e depósito dinâmico. */
import { describe, it, expect } from 'vitest';
import type { DealCommitment } from '../src/adapters/types.js';
import type { Role, Network } from '../src/domain/types.js';
import {
  evmGasPayerRole, evmGasPayer, lifecycleGasUnits, estimateGasPrepayWei,
  EVM_GAS_UNITS, DEFAULT_GAS_PREPAY_MARGIN_BPS,
} from '../src/engines/gasPrepay.js';

const ADDR = { seller: '0x1111111111111111111111111111111111111111', buyer: '0x2222222222222222222222222222222222222222' };
// Commitment mínimo (as funções puras só olham legs + participants).
const mk = (legs: { from: Role; escrowChain: Network }[], parts: { role: Role; address: string }[]): DealCommitment =>
  ({
    legs: legs.map((l, i) => ({ index: i, from: l.from, escrowChain: l.escrowChain })),
    participants: parts.map(p => ({ role: p.role, address: p.address })),
  } as unknown as DealCommitment);

describe('gasPrepay · pagador do gás EVM', () => {
  it('cross-chain Vendedor-externo (BTC) → Comprador deposita USDT na EVM → paga o COMPRADOR', () => {
    const c = mk(
      [{ from: 'SELLER', escrowChain: 'bitcoin' }, { from: 'BUYER', escrowChain: 'ethereum' }],
      [{ role: 'SELLER', address: 'bc1qxyz' }, { role: 'BUYER', address: ADDR.buyer }],
    );
    expect(evmGasPayerRole(c)).toBe('BUYER');
    expect(evmGasPayer(c)).toEqual({ role: 'BUYER', address: ADDR.buyer });
  });

  it('cross-chain Comprador-externo (BTC) → Vendedor deposita token na EVM → paga o VENDEDOR', () => {
    const c = mk(
      [{ from: 'SELLER', escrowChain: 'ethereum' }, { from: 'BUYER', escrowChain: 'bitcoin' }],
      [{ role: 'SELLER', address: ADDR.seller }, { role: 'BUYER', address: 'bc1qabc' }],
    );
    expect(evmGasPayerRole(c)).toBe('SELLER');
    expect(evmGasPayer(c).address).toBe(ADDR.seller);
  });

  it('mesma rede (2 pernas EVM) → paga o COMPRADOR', () => {
    const c = mk(
      [{ from: 'SELLER', escrowChain: 'ethereum' }, { from: 'BUYER', escrowChain: 'ethereum' }],
      [{ role: 'SELLER', address: ADDR.seller }, { role: 'BUYER', address: ADDR.buyer }],
    );
    expect(evmGasPayerRole(c)).toBe('BUYER');
  });

  it('sem perna EVM → lança (não há gás EVM a pré-pagar)', () => {
    const c = mk([{ from: 'SELLER', escrowChain: 'bitcoin' }, { from: 'BUYER', escrowChain: 'solana' }], []);
    expect(() => evmGasPayerRole(c)).toThrow(/sem perna EVM/);
  });

  it('pagador sem endereço EVM → lança', () => {
    const c = mk(
      [{ from: 'SELLER', escrowChain: 'bitcoin' }, { from: 'BUYER', escrowChain: 'ethereum' }],
      [{ role: 'BUYER', address: 'nao-e-evm' }],
    );
    expect(() => evmGasPayer(c)).toThrow(/sem endereço EVM/);
  });
});

describe('gasPrepay · dimensionamento do depósito', () => {
  it('reserva registro + o MAIOR entre settle/refund (não os dois)', () => {
    const esperado = EVM_GAS_UNITS.register + EVM_GAS_UNITS.settle; // settle > refund
    expect(lifecycleGasUnits()).toBe(esperado);
    expect(lifecycleGasUnits()).toBe(1_610_000n);
  });

  it('depósito dinâmico = unidades × gasPrice × margem (3×)', () => {
    const gwei = 1_000_000_000n; // 1 gwei
    const wei = estimateGasPrepayWei(gwei, DEFAULT_GAS_PREPAY_MARGIN_BPS);
    expect(wei).toBe(1_610_000n * gwei * 3n); // margem 30000 bps = 3,0×
  });

  it('gasPrice inválido lança', () => {
    expect(() => estimateGasPrepayWei(0n)).toThrow(/gasPrice/);
  });
});
