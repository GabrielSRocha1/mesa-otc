/** EvmChainAdapter — funções puras: paridade do RegisterInput com o harness, mapa de status e keyring dev. */
import { describe, it, expect } from 'vitest';
import { Chain, makeDeal, wallet } from './evm-harness.js';
import { buildRegisterInput, mapOnChainStatus, EvmDevKeyring } from '../src/adapters/evm.js';
import type { DealCommitment } from '../src/adapters/types.js';
import type { Hex } from '../src/engines/signature.js';

const ESCROW_ADDR = '0x00000000000000000000000000000000000e5c40' as Hex;

describe('buildRegisterInput — paridade com o harness (evmDealTerms)', () => {
  it('gera o mesmo RegisterInput que makeDeal para a mesma Deal', () => {
    const chain = new Chain(); chain.contract = ESCROW_ADDR;
    const token = '0x00000000000000000000000000000000000000aa';
    const d = makeDeal(chain, { participants: [wallet(), wallet(), wallet(), wallet()], token, tokenId: `eip155:1/erc20:${token}`, commissionBps: 1000, split: [700, 300], discountBps: 500, feeBps: 25 });
    const commitment: DealCommitment = { dealId: d.dealId, revision: d.terms.revision, dealHash: d.hash.dealHash, expiresAt: d.terms.expiresAt, participants: d.terms.participants, legs: d.terms.legs, pricingHash: d.hash.pricingHash, routeHash: d.hash.routeHash, domainHash: d.hash.domainHash, dealNonce: d.terms.dealNonce, feeBps: d.terms.pricing.platformFeeBps, treasury: '0x' + '11'.repeat(20), terms: d.terms };
    const { input, evm } = buildRegisterInput(commitment, 1n, ESCROW_ADDR);
    expect(input).toEqual(d.input);            // campo a campo, incluindo legs (token/decimals/canonicalId/isPayment)
    expect(evm.termsHash).toBe(d.evm.termsHash); // termsHash idêntico ao que o contrato computará
  });
});

describe('mapOnChainStatus', () => {
  it('mapeia o enum do contrato para a porta', () => {
    expect(mapOnChainStatus(0, 0, 2)).toBe('NONE');
    expect(mapOnChainStatus(1, 0, 2)).toBe('REGISTERED');  // CREATED sem depósitos
    expect(mapOnChainStatus(2, 2, 2)).toBe('FUNDED');      // ASSETS_LOCKED
    expect(mapOnChainStatus(4, 2, 2)).toBe('FUNDED');      // FULLY_SIGNED
    expect(mapOnChainStatus(7, 2, 2)).toBe('SETTLED');
    expect(mapOnChainStatus(8, 1, 2)).toBe('FUNDED');      // EXPIRED com depósito preso
    expect(mapOnChainStatus(10, 0, 2)).toBe('REFUNDED');
    expect(mapOnChainStatus(12, 0, 2)).toBe('SUPERSEDED');
  });
});

describe('EvmDevKeyring', () => {
  it('deriva EOAs determinísticas por dono e resolve por endereço', () => {
    const a = new EvmDevKeyring('ab'.repeat(32)); const b = new EvmDevKeyring('ab'.repeat(32));
    const addr = a.addressFor('SoLDono1111111111111111111111111111111111111');
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.addressFor('SoLDono1111111111111111111111111111111111111')).toBe(addr);          // determinístico
    expect(a.addressFor('OutroDono11111111111111111111111111111111111')).not.toBe(addr);      // 1 EOA por dono
    expect(a.accountByAddress(addr)?.address).toBe(addr);                                     // roundtrip
    expect(new EvmDevKeyring('cd'.repeat(32)).addressFor('SoLDono1111111111111111111111111111111111111')).not.toBe(addr); // segredo diferente
  });
});
