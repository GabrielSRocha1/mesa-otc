/** VerumEvmV2Adapter — mapeamento commitment → TermsV2 (cadeiras presentes + perna externa BTC). */
import { describe, it, expect } from 'vitest';
import { buildVerumTermsV2, evmLegMapOf } from '../src/adapters/verum/evmV2.js';
import type { DealCommitment } from '../src/adapters/types.js';

const TUSDT = '0x7DFdcc43D60C12634E24044eCE13ed6b031B6743';
const TBTC = '0xf6FC9A073Ecf7CB0dE845E71bF53fF87e3866c7D';
const htlcHash = 'ab'.repeat(32);

const asset = (network: string, contractOrMint: string | null) => ({ network, chainId: network === 'bitcoin' ? 'regtest' : '11155111', contractOrMint, code: 'X', decimals: 6, tokenStandard: 'x', assetId: 'x' });
function commitment(opts: { htlc?: boolean; roles?: string[]; btcBuyer?: boolean }): DealCommitment {
  const roles = opts.roles ?? ['SELLER', 'PAYMASTER_1', 'BUYER'];
  const participants = roles.map((role, i) => ({ role, network: 'ethereum', chainId: '11155111', keyScheme: 'secp256k1', address: `0x${String(i + 1).repeat(40)}` }));
  const legs = opts.htlc
    ? (opts.btcBuyer
      ? [
        { index: 0, from: 'SELLER', to: 'BUYER', escrowChain: 'ethereum', escrowContract: '0xe5c0', mode: 'ESCROW_NN', amountBase: '1000000000', asset: asset('ethereum', TUSDT) },
        { index: 1, from: 'BUYER', to: 'SELLER', escrowChain: 'bitcoin', escrowContract: 'bc1...', mode: 'HTLC', amountBase: '75000000', asset: asset('bitcoin', null) },
      ]
      : [
        { index: 0, from: 'SELLER', to: 'BUYER', escrowChain: 'bitcoin', escrowContract: 'bc1...', mode: 'HTLC', amountBase: '75000000', asset: asset('bitcoin', null) },
        { index: 1, from: 'BUYER', to: 'SELLER', escrowChain: 'ethereum', escrowContract: '0xe5c0', mode: 'ESCROW_NN', amountBase: '1000000000', asset: asset('ethereum', TUSDT) },
      ])
    : [
      { index: 0, from: 'SELLER', to: 'BUYER', escrowChain: 'ethereum', escrowContract: '0xe5c0', mode: 'ESCROW_NN', amountBase: '2000000', asset: asset('ethereum', TBTC) },
      { index: 1, from: 'BUYER', to: 'SELLER', escrowChain: 'ethereum', escrowContract: '0xe5c0', mode: 'ESCROW_NN', amountBase: '1000000000', asset: asset('ethereum', TUSDT) },
    ];
  return {
    dealId: 'OTC-v2-1', revision: 1, dealHash: 'h', expiresAt: Date.now() + 2400_000, participants, legs,
    pricingHash: '', routeHash: '', domainHash: '', dealNonce: 'n1', feeBps: 3, treasury: '0x' + '9'.repeat(40),
    htlcHash: opts.htlc ? htlcHash : undefined,
    terms: { pricing: { commissionBps: 200, discountBps: 300, maxSlippageBps: 50 } },
  } as unknown as DealCommitment;
}

describe('evmLegMapOf / buildVerumTermsV2', () => {
  it('deal direta (duas legs EVM): seller/buyer mapeados, sem htlcHash', () => {
    const c = commitment({});
    expect(evmLegMapOf(c)).toEqual({ sellerLegIndex: 0, buyerLegIndex: 1, external: false });
    const t = buildVerumTermsV2(c, 1_800_000_000);
    expect(t.sellerAsset).toBe(TBTC);
    expect(t.buyerAsset).toBe(TUSDT);
    expect(t.htlcHash).toBe('0x' + '0'.repeat(64));
    expect(t.termsVersion).toBe(2);
    expect(Number(t.expiresAt) - Number(t.createdAt)).toBe(2400);
    expect(t.participants.map(p => p.role)).toEqual([0, 1, 3]); // SELLER, PM1, BUYER — PM2 ausente é omitido
  });

  it('deal HTLC (BTC do vendedor): perna externa com sellerAsset=0, sats e htlcHash', () => {
    const c = commitment({ htlc: true });
    expect(evmLegMapOf(c)).toEqual({ sellerLegIndex: null, buyerLegIndex: 1, external: true });
    const t = buildVerumTermsV2(c, 1_800_000_000);
    expect(t.sellerAsset).toBe('0x0000000000000000000000000000000000000000');
    expect(t.sellerAmount).toBe(75_000_000n);
    expect(t.buyerAsset).toBe(TUSDT);
    expect(t.htlcHash).toBe('0x' + htlcHash);
  });

  it('BTC do lado COMPRADOR → erro nominal (limite documentado da v2)', () => {
    expect(() => evmLegMapOf(commitment({ htlc: true, btcBuyer: true }))).toThrow(/VENDEDOR/);
  });

  it('mesa de 4 cadeiras mantém a ordem canônica dos participantes', () => {
    const t = buildVerumTermsV2(commitment({ roles: ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'] }), 1_800_000_000);
    expect(t.participants.map(p => p.role)).toEqual([0, 1, 2, 3]);
  });
});
