/**
 * v3 — comissão na perna on-chain (comprador EXTERNO paga BTC/HTLC):
 *  - computeEconomics modo commissionLeg 'SELLER': perna do comprador = valor CHEIO com deságio;
 *    comissão/fee saem do lado do Vendedor (assetIn) e NADA é debitado da perna de saída.
 *  - buildVerumTermsV2 termsVersion 3: comissão em sellerAsset (commissionInSellerAsset);
 *    termsVersion 2 (escrow legado) mantém comissão ZERADA com comprador externo.
 */
import { describe, it, expect } from 'vitest';
import { PriceEngine, StaticPriceSource, DEFAULT_PRICE_CONFIG } from '../src/engines/price.js';
import { buildVerumTermsV2 } from '../src/adapters/verum/evmV2.js';
import { commissionInSellerAsset } from '../src/onchain/core/fee.js';
import type { DealCommitment } from '../src/adapters/types.js';
import type { CanonicalAsset } from '../src/domain/types.js';

const USDT = { network: 'ethereum', chainId: '11155111', contractOrMint: '0x7DFdcc43D60C12634E24044eCE13ed6b031B6743', code: 'USDT', decimals: 6, tokenStandard: 'erc20', assetId: 'usdt' } as unknown as CanonicalAsset;
const BTC = { network: 'bitcoin', chainId: 'signet', contractOrMint: null, code: 'BTC', decimals: 8, tokenStandard: 'native', assetId: 'btc' } as unknown as CanonicalAsset;

function engine(): PriceEngine {
  const prices = { usdt: 1, btc: 100_000 };
  return new PriceEngine([
    new StaticPriceSource('a', 1, { ...prices }),
    new StaticPriceSource('b', 1, { ...prices }),
    new StaticPriceSource('c', 1, { ...prices }),
  ], DEFAULT_PRICE_CONFIG);
}

const ECON_BASE = {
  assetIn: USDT, assetOut: BTC, amountInBase: '100000000000', // 100.000 USDT
  discountBps: 200, commissionBps: 100, commissionSplitBps: [60, 40],
  platformFeeBps: 3, paymasterShareBps: 0, maxSlippageBps: 50, maxPriceDriftBps: 100,
  networkCostUsd: { in: '1.00', out: '1.00' },
};

describe('computeEconomics — commissionLeg', () => {
  it("modo BUYER (default): perna do comprador LÍQUIDA da comissão, fee debitada do net", async () => {
    const pe = engine();
    const snapshot = await pe.quote(['usdt', 'btc']);
    const econ = pe.computeEconomics({ ...ECON_BASE, snapshot });
    // 100.000 × 0,98 = 98.000; comissão 1% = 980; out = 97.020 USD → 0,9702 BTC
    expect(econ.amountOutBase).toBe('97020000');
    expect(econ.pricing.usdCommission).toBe('980.00');
    expect(econ.pricing.netAmountSellerBase).toBe(String(97_020_000 - 29_106)); // − fee 3 bps
    expect(econ.pricing.commissionLeg).toBeUndefined(); // omitido → hash idêntico ao fluxo atual
  });

  it("modo SELLER (comprador externo, v3): perna CHEIA com deságio; nada debitado da saída", async () => {
    const pe = engine();
    const snapshot = await pe.quote(['usdt', 'btc']);
    const econ = pe.computeEconomics({ ...ECON_BASE, snapshot, commissionLeg: 'SELLER' });
    // 100.000 × 0,98 = 98.000 USD → 0,98 BTC INTEIRO (comissão e fee saem do lado USDT do Vendedor)
    expect(econ.amountOutBase).toBe('98000000');
    expect(econ.pricing.netAmountSellerBase).toBe('98000000');
    expect(econ.feeBase).toBe('0');
    expect(econ.pricing.usdCommission).toBe('980.00'); // informacional: o que os PMs recebem
    expect(econ.pricing.commissionLeg).toBe('SELLER');
    // a comissão correspondente em assetIn: 100.000 × 0,98 × 1% = 980 USDT
    expect(commissionInSellerAsset(100_000_000_000n, 200, 100)).toBe(980_000_000n);
    // o Vendedor entrega o escrito CRAVADO, como sempre
    expect(econ.amountInEffectiveBase).toBe('100000000000');
  });
});

// ---- builder EVM: comissão em sellerAsset no termsVersion 3 ----
const TUSDT = '0x7DFdcc43D60C12634E24044eCE13ed6b031B6743';
const htlcHash = 'ab'.repeat(32);
const asset = (network: string, contractOrMint: string | null) => ({ network, chainId: network === 'bitcoin' ? 'regtest' : '11155111', contractOrMint, code: 'X', decimals: 6, tokenStandard: 'x', assetId: 'x' });
function btcBuyerCommitment(): DealCommitment {
  const roles = ['SELLER', 'PAYMASTER_1', 'PAYMASTER_2', 'BUYER'];
  const participants = roles.map((role, i) => ({ role, network: 'ethereum', chainId: '11155111', keyScheme: 'secp256k1', address: `0x${String(i + 1).repeat(40)}` }));
  return {
    dealId: 'OTC-v3-1', revision: 1, dealHash: 'h', expiresAt: Date.now() + 2400_000, participants,
    legs: [
      { index: 0, from: 'SELLER', to: 'BUYER', escrowChain: 'ethereum', escrowContract: '0xe5c0', mode: 'ESCROW_NN', amountBase: '1000000000', asset: asset('ethereum', TUSDT) },
      { index: 1, from: 'BUYER', to: 'SELLER', escrowChain: 'bitcoin', escrowContract: 'bc1...', mode: 'HTLC', amountBase: '75000000', asset: asset('bitcoin', null) },
    ],
    pricingHash: '', routeHash: '', domainHash: '', dealNonce: 'n1', feeBps: 3, treasury: '0x' + '9'.repeat(40),
    htlcHash,
    terms: { pricing: { commissionBps: 200, discountBps: 300, maxSlippageBps: 50, commissionSplitBps: [150, 50], commissionLeg: 'SELLER' } },
  } as unknown as DealCommitment;
}

describe('buildVerumTermsV2 — comprador externo (BTC)', () => {
  it('termsVersion 3: comissão em sellerAsset = in·(1−d)·c, split assinado, resto → PM1', () => {
    const t = buildVerumTermsV2(btcBuyerCommitment(), 1_800_000_000, null, 3);
    expect(t.termsVersion).toBe(3);
    expect(t.buyerAsset).toBe('0x0000000000000000000000000000000000000000'); // perna externa
    // 1e9 × 9700/10000 × 200/10000 = 19.400.000 (unidades do sellerAsset)
    const total = 19_400_000n;
    expect(t.commissionPm1 + t.commissionPm2).toBe(total);
    expect(t.commissionPm2).toBe(total * 50n / 200n); // split [150, 50]
    expect(t.commissionPm1).toBe(total - total * 50n / 200n);
  });

  it('termsVersion 2 (escrow legado): comissão ZERADA com comprador externo — como hoje', () => {
    const t = buildVerumTermsV2(btcBuyerCommitment(), 1_800_000_000); // default = 2
    expect(t.termsVersion).toBe(2);
    expect(t.commissionPm1).toBe(0n);
    expect(t.commissionPm2).toBe(0n);
  });

  it('termsVersion 3 same-chain: comissão segue em buyerAsset (regra atual intacta)', () => {
    const c = btcBuyerCommitment();
    // vira same-chain: perna do comprador na EVM
    (c as unknown as { legs: { escrowChain: string; asset: ReturnType<typeof asset> }[]; htlcHash?: string }).legs[1]!.escrowChain = 'ethereum';
    c.legs[1]!.asset = asset('ethereum', '0xf6FC9A073Ecf7CB0dE845E71bF53fF87e3866c7D') as never;
    (c as { htlcHash?: string }).htlcHash = undefined;
    const t = buildVerumTermsV2(c, 1_800_000_000, null, 3);
    // amountOut 75e6 · c=200 · d=300 → total = 75e6·200/9500 = 1.578.947 (buyerAsset)
    expect(t.commissionPm1 + t.commissionPm2).toBe(1_578_947n);
  });
});
