/**
 * Guarda de regressão do vendoring (src/onchain): golden vectors TS↔Solidity, layout borsh
 * Solana, endereços Tron e forma dos ABIs. Portado de verum-otc-onchain/tests/unit/crypto.test.ts.
 * Se algum destes quebrar após um sync-onchain, o crypto vendorado divergiu do contrato.
 */
import { describe, it, expect } from 'vitest';
import { decodeFunctionData, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Role, TokenStatus, type Terms } from '../src/onchain/types.js';
import { TRADE_DURATION_SECONDS } from '../src/onchain/core/index.js';
import {
  TERMS_TYPEHASH, hashTermsEvm, computeTradeIdEvm, approvalDigestEvm, attestationDigestEvm,
  signApprovalEvm, signWalletAttestationEvm,
  hashTermsSolana, computeTradeIdSolana, serializeTermsSolana, toHex as hex,
  tronToEvmAddress, evmToTronAddress, base58Encode, base58Decode,
} from '../src/onchain/crypto/index.js';
import { ESCROW_ABI, EvmCalldata } from '../src/onchain/router/adapters/evm.js';
import { TRON_ESCROW_ABI } from '../src/onchain/router/adapters/tron.js';

const CHAIN_ID = 11155111;
const ESCROW = '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f';
const USDT = '0x7169d38820dfd117c3fa1f22a697dba58d90ba06';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const START = 1_790_000_000;

function makeTerms(over: Partial<Terms> = {}): Terms {
  return {
    chainId: CHAIN_ID, escrowAddress: ESCROW,
    seller: '0x1111111111111111111111111111111111111111', buyer: '0x2222222222222222222222222222222222222222',
    paymaster01: '0x3333333333333333333333333333333333333333', paymaster02: '0x4444444444444444444444444444444444444444',
    sellerAsset: USDT, sellerAmount: 1_000_000_000_000n,
    buyerAsset: USDC, buyerAmount: 999_000_000_000n,
    platformFeeBps: 3, commissionBps: 200, discountBps: 300, slippageBps: 50,
    createdAt: START, expiresAt: START + TRADE_DURATION_SECONDS, termsVersion: 1, nonce: 1n,
    ...over,
  };
}

/** Vetores gerados pelo Foundry (contracts/evm/test/Golden.t.sol) — equivalência byte a byte com o contrato. */
const GOLDEN = {
  TERMS_TYPEHASH: '0xe9ab926f03deadaba775ef8f09b60ed96feb148e716c5dd901a76a8f4248e7ac',
  termsHash: '0x86082d23527e2a65a5e45a5aefa3f1f29d46234f304c073a0dd6c88233297327',
  tradeId: '0x35bb9430e2eabe33255dc06cfc27aba8d84b77314b1143ac50317ca315ef16b1',
  approvalDigest: '0x42bbff0b6e02894c6889315fb0421e404f7e5c1c54086a1671c3d993773c9423',
  attestationDigest: '0xdb9315a5d34864cefa3bb41a6c18b9ee17d558dd3c1b0372d6b15cfe2d83f92a',
};

describe('onchain/crypto evm — golden vectors do contrato Solidity', () => {
  const t = makeTerms();
  it('TERMS_TYPEHASH idêntico', () => expect(TERMS_TYPEHASH).toBe(GOLDEN.TERMS_TYPEHASH));
  it('hashTerms idêntico', () => expect(hashTermsEvm(t)).toBe(GOLDEN.termsHash));
  it('tradeId = keccak(chainId, escrow, termsHash)', () => expect(computeTradeIdEvm(CHAIN_ID, ESCROW, hashTermsEvm(t))).toBe(GOLDEN.tradeId));
  it('approvalDigest EIP-712 idêntico', () =>
    expect(approvalDigestEvm(CHAIN_ID, ESCROW, GOLDEN.tradeId as `0x${string}`, GOLDEN.termsHash as `0x${string}`, Role.SELLER, 1_790_000_600)).toBe(GOLDEN.approvalDigest));
  it('attestationDigest EIP-712 idêntico', () =>
    expect(attestationDigestEvm(CHAIN_ID, ESCROW, t.seller, 1_790_086_400)).toBe(GOLDEN.attestationDigest));
  it('tradeId muda com chainId e com contrato', () => {
    const th = hashTermsEvm(t);
    expect(computeTradeIdEvm(1, ESCROW, th)).not.toBe(computeTradeIdEvm(CHAIN_ID, ESCROW, th));
    expect(computeTradeIdEvm(CHAIN_ID, '0x9999999999999999999999999999999999999999', th)).not.toBe(computeTradeIdEvm(CHAIN_ID, ESCROW, th));
  });
  it('qualquer alteração nos termos altera o hash', () => {
    const base = hashTermsEvm(t);
    for (const over of [{ sellerAmount: t.sellerAmount + 1n }, { buyer: t.paymaster01 }, { platformFeeBps: 4 }, { expiresAt: t.expiresAt + 1 }, { nonce: 2n }, { commissionBps: 201 }] as const) {
      expect(hashTermsEvm(makeTerms(over))).not.toBe(base);
    }
  });
  it('assinatura EIP-712 recuperável e vinculada ao papel', async () => {
    const pk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
    const acct = privateKeyToAccount(pk);
    const th = hashTermsEvm(t); const id = computeTradeIdEvm(CHAIN_ID, ESCROW, th);
    const sig = await signApprovalEvm(pk, CHAIN_ID, ESCROW, id, th, Role.SELLER, t.expiresAt);
    expect(sig.signer).toBe(acct.address);
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const sig2 = await signApprovalEvm(pk, CHAIN_ID, ESCROW, id, th, Role.BUYER, t.expiresAt);
    expect(sig2.signature).not.toBe(sig.signature);
    const att = await signWalletAttestationEvm(pk, CHAIN_ID, ESCROW, t.seller, t.expiresAt + 86400);
    expect(att.wallet.toLowerCase()).toBe(t.seller.toLowerCase());
  });
});

describe('onchain/crypto evm — calldata bate com a ABI', () => {
  const t = makeTerms();
  it('createTrade decodifica de volta aos mesmos termos', () => {
    const atts = [t.seller, t.paymaster01, t.paymaster02, t.buyer].map((w) => ({ wallet: w, validUntil: t.expiresAt + 1, signature: '0x' + '11'.repeat(65) }));
    const data = EvmCalldata.createTrade(t, atts);
    expect(data.slice(0, 10)).toBe(toFunctionSelector('createTrade((address,address,address,address,address,uint256,address,uint256,uint16,uint16,uint16,uint16,uint64,uint64,uint32,uint256),(uint64,bytes)[4])'));
    const dec = decodeFunctionData({ abi: ESCROW_ABI, data });
    expect(dec.functionName).toBe('createTrade');
    const terms = (dec.args as [Record<string, unknown>, unknown[]])[0];
    expect(terms.sellerAmount).toBe(t.sellerAmount);
    expect(String(terms.seller).toLowerCase()).toBe(t.seller.toLowerCase());
    expect((dec.args as [unknown, unknown[]])[1]).toHaveLength(4);
  });
  it('sign/settle/expire/refund usam os seletores corretos', () => {
    const id = GOLDEN.tradeId; const th = GOLDEN.termsHash;
    const approval = { role: Role.PAYMASTER_02, signer: t.paymaster02, tradeId: id, termsHash: th, deadline: t.expiresAt, signature: '0x' + '22'.repeat(65) };
    expect(EvmCalldata.sign(approval).slice(0, 10)).toBe(toFunctionSelector('paymaster02Sign(bytes32,uint64,bytes)'));
    expect(EvmCalldata.sign({ ...approval, role: Role.SELLER }).slice(0, 10)).toBe(toFunctionSelector('sellerSign(bytes32,uint64,bytes)'));
    expect(EvmCalldata.settle(id).slice(0, 10)).toBe(toFunctionSelector('settle(bytes32)'));
    expect(EvmCalldata.expire(id).slice(0, 10)).toBe(toFunctionSelector('expireTrade(bytes32)'));
    expect(EvmCalldata.refund(id).slice(0, 10)).toBe(toFunctionSelector('refund(bytes32)'));
  });
  it('ABI não contém saque administrativo nem upgrade', () => {
    const names = ESCROW_ABI.filter((x) => x.type === 'function').map((x) => (x as { name: string }).name.toLowerCase());
    for (const forbidden of ['withdraw', 'admintransfer', 'sweep', 'upgradeto', 'setimplementation', 'rescue', 'emergencywithdraw']) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    }
  });
});

describe('onchain — guarda de forma dos ABIs (EVM vs Tron)', () => {
  type AbiEntry = { type: string; name?: string; inputs?: { type: string }[] };
  const fns = (abi: readonly unknown[]) => new Map((abi as AbiEntry[]).filter((e) => e.type === 'function' && e.name).map((e) => [e.name!, e]));
  const sig = (e: AbiEntry) => JSON.stringify((e.inputs ?? []).map((i) => i.type));
  const evm = fns(ESCROW_ABI); const tron = fns(TRON_ESCROW_ABI);
  it('ABI Tron é o build Tron (TRON_CHAIN_ID, sem EXPECTED_CHAIN_ID)', () => {
    expect(tron.has('TRON_CHAIN_ID')).toBe(true);
    expect(tron.has('EXPECTED_CHAIN_ID')).toBe(false);
    expect(evm.has('EXPECTED_CHAIN_ID')).toBe(true);
  });
  it('trade-path idêntica nos dois ABIs', () => {
    for (const name of ['createTrade', 'sellerSign', 'paymaster01Sign', 'paymaster02Sign', 'buyerSign', 'settle', 'expireTrade', 'refund', 'getTrade', 'isTokenActive', 'paused', 'platformFeeBps', 'hashTerms', 'computeTradeId', 'domainSeparator']) {
      const e = evm.get(name), t2 = tron.get(name);
      expect(e, `ausente no ABI EVM: ${name}`).toBeDefined();
      expect(t2, `ausente no ABI Tron: ${name}`).toBeDefined();
      expect(sig(t2!), `inputs divergem em ${name}`).toBe(sig(e!));
    }
  });
});

describe('onchain/crypto solana — layout borsh determinístico', () => {
  const SOL = 'So11111111111111111111111111111111111111112';
  const OTHER_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const t = makeTerms({
    chainId: 103, escrowAddress: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    seller: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', buyer: '9vYWHBPz817wJdQpE8u3h1qTTe3x4L7DJhm2x9ZPt4g6',
    paymaster01: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', paymaster02: 'GkVvdvAvo3g4VxKyGThLByzePKktuMAAN9vhNyQXuo4z',
    sellerAsset: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', buyerAsset: SOL,
  });
  it('serialização tem 244 bytes (Terms::SERIALIZED_LEN em Rust)', () => expect(serializeTermsSolana(t).length).toBe(244));
  it('campos little-endian nas posições esperadas', () => {
    const b = serializeTermsSolana(t);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(dv.getBigUint64(160, true)).toBe(t.sellerAmount);
    expect(dv.getUint16(208, true)).toBe(3);
    expect(dv.getBigInt64(216, true)).toBe(BigInt(t.createdAt));
    expect(dv.getUint32(232, true)).toBe(1);
    expect(dv.getBigUint64(236, true)).toBe(t.nonce);
  });
  it('hash e tradeId determinísticos e sensíveis ao programa', () => {
    const h1 = hex(hashTermsSolana(t));
    expect(hex(hashTermsSolana(makeTerms({ ...t, nonce: 2n })))).not.toBe(h1);
    expect(hex(computeTradeIdSolana(t.escrowAddress, hashTermsSolana(t)))).not.toBe(hex(computeTradeIdSolana(OTHER_PROGRAM, hashTermsSolana(t))));
    expect(hex(hashTermsSolana(t))).toBe(h1);
  });
  it('base58 roundtrip', () => {
    const bytes = base58Decode(SOL);
    expect(bytes.length).toBe(32);
    expect(base58Encode(bytes)).toBe(SOL);
  });
});

describe('onchain/crypto tron — endereços', () => {
  it('T... ↔ 0x roundtrip com checksum', () => {
    const usdtTron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const evm = tronToEvmAddress(usdtTron);
    expect(evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(evmToTronAddress(evm)).toBe(usdtTron);
    expect(() => tronToEvmAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toThrow();
  });
});

describe('onchain/registry — status', () => {
  it('TokenStatus é enum nativo utilizável', () => {
    expect(TokenStatus.ACTIVE).toBeDefined();
  });
});
