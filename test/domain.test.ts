import { describe, it, expect } from 'vitest';
import { canonicalize, computeDealHash, type Terms } from '../src/domain/types.js';
import { TRANSITIONS, canTransition, assertTransition } from '../src/domain/stateMachine.js';
import { AuditLog } from '../src/audit/audit.js';
import { MemoryStore } from '../src/db/memoryStore.js';

const base = (): Terms => ({ schemaVersion: 1, environment: 'dev', dealId: 'OTC-1', revision: 1, createdAt: 1, expiresAt: 1000,
  participants: [{ role: 'SELLER', network: 'solana', chainId: 'localnet', address: 'A', keyScheme: 'ed25519' }, { role: 'BUYER', network: 'solana', chainId: 'localnet', address: 'B', keyScheme: 'ed25519' }, { role: 'PAYMASTER_1', network: 'ethereum', chainId: '31337', address: 'P', keyScheme: 'secp256k1' }],
  requiredSignatures: 3,
  legs: [{ index: 0, asset: { code: 'SOL', network: 'solana', chainId: 'localnet', contractOrMint: null, assetId: 'solana:localnet/slip44:501', decimals: 9, tokenStandard: 'native', issuer: 'native', status: 'active' }, amountBase: '10', from: 'SELLER', to: 'BUYER', escrowChain: 'solana', escrowContract: 'E', mode: 'ESCROW_NN' },
         { index: 1, asset: { code: 'USDC', network: 'solana', chainId: 'localnet', contractOrMint: 'M', assetId: 'solana:localnet/token:M', decimals: 6, tokenStandard: 'SPL', issuer: 'Circle', status: 'active' }, amountBase: '20', from: 'BUYER', to: 'SELLER', escrowChain: 'solana', escrowContract: 'E', mode: 'ESCROW_NN' }],
  pricing: { referencePriceInUsd: '150', referencePriceOutUsd: '1', quoteTimestamp: 1, priceValidUntil: 2, usdValueIn: '1500', usdValueOut: '1485', discountBps: 100, commissionBps: 0, commissionSplitBps: [0], usdCommission: '0.00', platformFeeBps: 25, paymasterShareBps: 0, maxSlippageBps: 50, maxPriceDriftBps: 100, networkCostEstimateUsd: { in: '0.01', out: '0.01' }, netAmountSellerBase: '19', priceSnapshotId: 'PS-1' },
  route: { routeId: 'RT', kind: 'ESCROW_NN', legs: [{ escrowChain: 'solana', escrowContract: 'E', mode: 'ESCROW_NN', fundingOrder: 1, timelockSec: 3600 }] }, dealNonce: 'n' });

describe('Domain Model', () => {
  it('canonicalize é determinística e independe da ordem das chaves', () => { expect(canonicalize({ b: 1, a: { d: 2n, c: [3] } })).toBe('{"a":{"c":[3],"d":"2"},"b":1}'); });
  it('dealHash é determinístico e sensível a cada campo dos termos (participantes, legs, preço, rota, expiração, nonce, revisão, ambiente)', () => {
    const h0 = computeDealHash(base()).dealHash; expect(h0).toBe(computeDealHash(base()).dealHash); expect(h0).toHaveLength(64);
    const variants: ((t: Terms) => void)[] = [t => { t.revision = 2; }, t => { t.expiresAt = 1001; }, t => { t.dealNonce = 'm'; }, t => { t.environment = 'prod'; }, t => { t.route.routeId = 'RT2'; }, t => { t.route.legs[0]!.escrowContract = 'E2'; }, t => { t.pricing.discountBps = 101; }, t => { t.pricing.maxPriceDriftBps = 200; }, t => { t.legs[1]!.amountBase = '21'; }, t => { t.legs[0]!.to = 'PAYMASTER_1'; }, t => { t.legs[1]!.asset.contractOrMint = 'FAKE'; }, t => { t.legs[1]!.asset.decimals = 8; }, t => { t.participants[2]!.address = 'Q'; }, t => { t.participants.push({ role: 'PAYMASTER_2', network: 'solana', chainId: 'localnet', address: 'Z', keyScheme: 'ed25519' }); }, t => { t.participants[0]!.network = 'ethereum'; }];
    const hashes = new Set(variants.map(m => { const t = base(); m(t); return computeDealHash(t).dealHash; })); expect(hashes.size).toBe(variants.length); expect(hashes.has(h0)).toBe(false);
  });
  it('legsRoot ignora ordem de entrada das legs (ordenação por index)', () => { const t = base(); t.legs.reverse(); expect(computeDealHash(t).dealHash).toBe(computeDealHash(base()).dealHash); });
});
describe('State Machine', () => {
  it('mapa fechado: proibidas nunca passam', () => {
    for (const from of ['SETTLED', 'REFUNDED', 'CANCELLED'] as const) expect(TRANSITIONS[from]).toEqual([]);
    for (const from of ['EXPIRED', 'BLOCKED', 'REFUNDING', 'CANCELLED', 'REFUNDED'] as const) { expect(canTransition(from, 'SETTLING')).toBe(false); expect(canTransition(from, 'SETTLED')).toBe(false); }
    expect(canTransition('FULLY_SIGNED', 'CANCELLED')).toBe(false); expect(canTransition('AWAITING_SIGNATURES', 'SETTLING')).toBe(false); expect(canTransition('SETTLEMENT_VALIDATION', 'SETTLED')).toBe(false);
    expect(() => assertTransition('BLOCKED', 'SETTLING')).toThrow(/não permitida/);
  });
  it('SETTLING só a partir de SETTLEMENT_VALIDATION; SETTLED só a partir de SETTLING', () => { const from = (to: string) => (Object.keys(TRANSITIONS) as (keyof typeof TRANSITIONS)[]).filter(k => (TRANSITIONS[k] as readonly string[]).includes(to)); expect(from('SETTLING')).toEqual(['SETTLEMENT_VALIDATION']); expect(from('SETTLED')).toEqual(['SETTLING']); });
});
describe('Audit Log', () => {
  it('cadeia de hash verificável e detecta adulteração', async () => {
    const store = new MemoryStore(); const audit = new AuditLog(store, () => 1);
    await Promise.all([audit.append({ actorType: 'system', actorId: 's', category: 'a', dealId: null, payload: { n: 1 } }), audit.append({ actorType: 'system', actorId: 's', category: 'b', dealId: null, payload: { n: 2 } })]);
    const evs = await store.listAudit(); expect(evs.map(e => e.seq)).toEqual([1, 2]); expect(AuditLog.verify(evs).ok).toBe(true);
    const tampered = structuredClone(evs); tampered[0]!.payload = { n: 99 }; expect(AuditLog.verify(tampered)).toEqual({ ok: false, brokenAt: 1 });
  });
});
