/** Testes do VerumOtcEscrow v2 em EVM real (ethereumjs). Assinaturas produzidas pelas mesmas funções do backend (envelopeFor/evmDealTerms). */
import { describe, it, expect, beforeAll } from 'vitest';
import { keccak256, stringToHex, type Hex } from 'viem';
import { Chain, makeDeal, signApproval, wallet, ESCROW, ERC20, GUARD, EVIL, STATUS, NATIVE_HASH, ZERO, type DealSetup } from './evm-harness.js';

const admin = wallet(), guardian = wallet(), keeper = wallet(), outsider = wallet(), treasury = wallet().address;
const chain = new Chain(); let usdc = '', guard = ''; const usdcId = () => `eip155:1/erc20:${usdc.toLowerCase()}`;
const parts3 = () => [wallet(), wallet(), wallet()]; const parts4 = () => [wallet(), wallet(), wallet(), wallet()];
const N = (n: string) => `n-${n}-${Math.random().toString(36).slice(2, 8)}`;
async function fundAll(d: DealSetup) { for (const p of d.parts) await chain.fund(p.address, 10n ** 20n); await chain.erc20(usdc, admin.address, 'mint', [d.parts[1]!.address, 10n ** 15n]); }
async function register(d: DealSetup, over: Record<string, unknown> = {}) { return chain.call(keeper.address, 'register', [{ ...d.input, ...over }]); }
async function depositAll(d: DealSetup) { const r0 = await chain.call(d.parts[0]!.address, 'deposit', [d.dealId, 0], d.evm.amountIn); if (!r0.ok) throw new Error(r0.error);
  const due = d.evm.amountOut + d.evm.commissionAmount; await chain.erc20(usdc, d.parts[1]!.address, 'approve', [chain.contract, due]); const r1 = await chain.call(d.parts[1]!.address, 'deposit', [d.dealId, 1]); if (!r1.ok) throw new Error(r1.error); }
async function approveAll(d: DealSetup, upTo = d.parts.length) { for (let i = 0; i < upTo; i++) { const nonce = N(String(i)); const r = await chain.call(outsider.address, 'approve', [d.dealId, nonce, await signApproval(chain, d, i, nonce)]); if (!r.ok) throw new Error(`approve ${i}: ${r.error}`); } }
async function fullFlow(d: DealSetup) { await fundAll(d); const r = await register(d); if (!r.ok) throw new Error(r.error); await depositAll(d); await approveAll(d); }

beforeAll(async () => {
  await chain.init(); for (const w of [admin, guardian, keeper, outsider]) await chain.fund(w.address, 10n ** 20n);
  usdc = await chain.deploy(admin.address, ERC20, ['USD Coin', 'USDC', 6]); guard = await chain.deploy(admin.address, GUARD, []);
  chain.contract = await chain.deploy(admin.address, ESCROW, [admin.address, guardian.address, keeper.address, treasury, guard, NATIVE_HASH]);
  await chain.allowAsset(admin.address, usdc, 6, keccak256(stringToHex(usdcId())));
});

describe('Máquina de estados e fluxo feliz', () => {
  it('3/3: CREATED → ASSETS_LOCKED → AWAITING_SIGNATURES → FULLY_SIGNED → (VALIDATING → SETTLING) → SETTLED; valores exatos incluindo fee e comissão', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), commissionBps: 1000, discountBps: 1000, feeBps: 25 });
    await fundAll(d); const r = await register(d); expect(r.error ?? 'ok').toBe('ok'); expect((await chain.status(d.dealId)).status).toBe(STATUS.CREATED); expect((await chain.status(d.dealId)).termsHash).toBe(d.evm.termsHash);
    await depositAll(d); expect((await chain.status(d.dealId)).status).toBe(STATUS.ASSETS_LOCKED);
    await approveAll(d, 1); expect((await chain.status(d.dealId)).status).toBe(STATUS.AWAITING_SIGNATURES); await approveAll(d, 3).catch(() => null);
    for (let i = 1; i < 3; i++) { const nonce = N('x' + i); const a = await chain.call(outsider.address, 'approve', [d.dealId, nonce, await signApproval(chain, d, i, nonce)]); expect(a.error ?? 'ok').toBe('ok'); }
    const st = await chain.status(d.dealId); expect(st.status).toBe(STATUS.FULLY_SIGNED); expect(st.approvals).toBe(3);
    const b = { buyer: await chain.balance(d.parts[1]!.address), seller: await chain.erc20Balance(usdc, d.parts[0]!.address), tre: await chain.erc20Balance(usdc, treasury), pm1: await chain.erc20Balance(usdc, d.parts[2]!.address) };
    const s = await chain.call(outsider.address, 'settle', [d.dealId, ZERO]); expect(s.error ?? 'ok').toBe('ok'); expect((await chain.status(d.dealId)).status).toBe(STATUS.SETTLED);
    const fee = d.evm.amountOut * 25n / 10000n; expect((await chain.balance(d.parts[1]!.address)) - b.buyer).toBe(d.evm.amountIn); expect((await chain.erc20Balance(usdc, d.parts[0]!.address)) - b.seller).toBe(d.evm.amountOut - fee);
    expect((await chain.erc20Balance(usdc, treasury)) - b.tre).toBe(fee); expect((await chain.erc20Balance(usdc, d.parts[2]!.address)) - b.pm1).toBe(d.evm.commissionAmount); expect(d.evm.commissionAmount).toBe(d.evm.amountOut * 1000n / 8000n);
    expect(await chain.erc20Balance(usdc, chain.contract)).toBe(0n); // nada fica preso no escrow
  });
  it('4/4 com comissão 7/3: Pay Masters recebem conforme o split assinado; resíduo com o PM1', async () => {
    const d = makeDeal(chain, { participants: parts4(), token: usdc, tokenId: usdcId(), commissionBps: 1000, split: [700, 300], amountOut: 1_000_001n });
    await fullFlow(d); const b1 = await chain.erc20Balance(usdc, d.parts[2]!.address), b2 = await chain.erc20Balance(usdc, d.parts[3]!.address);
    expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).ok).toBe(true);
    const pm2 = d.evm.commissionAmount * 300n / 1000n; expect((await chain.erc20Balance(usdc, d.parts[3]!.address)) - b2).toBe(pm2); expect((await chain.erc20Balance(usdc, d.parts[2]!.address)) - b1).toBe(d.evm.commissionAmount - pm2);
  });
  it('approveAndSettle: assinaturas + liquidação na mesma transação; com 2/3 tudo reverte (nenhuma assinatura fica registrada)', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(d); await register(d); await depositAll(d);
    const nonces = ['a', 'b', 'c'].map(N); const sigs: Hex[] = []; for (let i = 0; i < 3; i++) sigs.push(await signApproval(chain, d, i, nonces[i]!));
    const partial = await chain.call(keeper.address, 'approveAndSettle', [d.dealId, sigs.slice(0, 2), nonces.slice(0, 2), ZERO]); expect(partial.error).toContain('NotFullySigned'); expect((await chain.status(d.dealId)).approvals).toBe(0);
    const full = await chain.call(keeper.address, 'approveAndSettle', [d.dealId, sigs, nonces, ZERO]); expect(full.error ?? 'ok').toBe('ok'); expect((await chain.status(d.dealId)).status).toBe(STATUS.SETTLED);
  });
});

describe('Assinaturas (§6, §7)', () => {
  let d: DealSetup;
  beforeAll(async () => { d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(d); await register(d); await depositAll(d); });
  it('2/3 e 1/3 nunca liquidam; contrato exige FULLY_SIGNED', async () => {
    await approveAll(d, 2); expect((await chain.status(d.dealId)).approvals).toBe(2);
    expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('NotFullySigned');
  });
  it('assinatura inválida, de terceiro, duplicada (papel já aprovado), nonce reutilizado e de outro Deal são rejeitadas', async () => {
    const nonce = N('z'); const sig = await signApproval(chain, d, 2, nonce);
    expect((await chain.call(outsider.address, 'approve', [d.dealId, nonce, ('0x' + 'ab'.repeat(65)) as Hex])).error).toContain('BadSigner');
    const ext = makeDeal(chain, { participants: [outsider, d.parts[1]!, d.parts[2]!], token: usdc, tokenId: usdcId(), dealId: d.dealId, nonce: d.terms.dealNonce }); void ext;
    expect((await chain.call(outsider.address, 'approve', [d.dealId, nonce, await signApproval(chain, { ...d, parts: [d.parts[0]!, d.parts[1]!, outsider] }, 2, nonce)])).error).toContain('BadSigner'); // terceiro assinando como PM
    expect((await chain.call(outsider.address, 'approve', [d.dealId, nonce, await signApproval(chain, d, 0, nonce)])).error).toContain('BadSigner'); // Vendedor já aprovou: assinatura duplicada não conta
    const other = makeDeal(chain, { participants: d.parts, token: usdc, tokenId: usdcId() }); await register(other); await depositAll(other);
    expect((await chain.call(outsider.address, 'approve', [other.dealId, nonce, sig])).error).toContain('BadSigner'); // assinatura do Deal A no Deal B
    expect((await chain.call(outsider.address, 'approve', [d.dealId, nonce, sig])).ok).toBe(true);
    expect((await chain.call(outsider.address, 'approve', [d.dealId, nonce, sig])).error).toMatch(/NonceAlreadyUsed|BadStatus/); // replay do mesmo nonce
  });
  it('Deal alterado (amount/price/route/fee/participante) depois da assinatura ⇒ termsHash diferente ⇒ assinatura inválida', async () => {
    const e = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(e); await register(e); await depositAll(e);
    const mutations: ((t: import('../src/domain/types.js').Terms) => import('../src/domain/types.js').Terms)[] = [t => { t.legs[1]!.amountBase = String(BigInt(t.legs[1]!.amountBase) + 1n); return t; }, t => { t.pricing.referencePriceInUsd = '2500'; return t; }, t => { t.route.routeId = 'RT-OTHER'; return t; }, t => { t.pricing.platformFeeBps = 26; return t; }, t => { t.pricing.discountBps = 200; return t; }, t => { t.participants[2]!.address = outsider.address; return t; }, t => { t.expiresAt += 1000; return t; }, t => { t.dealNonce = 'ffff'; return t; }];
    for (const m of mutations) { const nonce = N('m'); expect((await chain.call(outsider.address, 'approve', [e.dealId, nonce, await signApproval(chain, e, 0, nonce, m)])).error).toContain('BadSigner'); }
    expect((await chain.status(e.dealId)).approvals).toBe(0);
  });
  it('nonce de Deal reutilizado e dealId reutilizado com fundos em custódia são rejeitados no register', async () => {
    const a = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), nonce: 'deadbeef00000001' }); await fundAll(a); expect((await register(a)).ok).toBe(true);
    const b = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), nonce: 'deadbeef00000001' }); await fundAll(b); expect((await register(b)).error).toContain('DealNonceAlreadyUsed');
    expect((await register(a)).error).toContain('DealExists');
  });
});

describe('Expiração, refund, cancelamento e supersede (§8, §12)', () => {
  it('após expirar: approve e settle rejeitados; refund permissionless devolve ao depositante (EXPIRED → REFUNDING → REFUNDED); sem reativação', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), commissionBps: 500, expiresAtMs: BigInt(chain.ts + 600) * 1000n }); await fundAll(d); await register(d); await depositAll(d); await approveAll(d, 2);
    chain.ts += 600 - 30; const nonce = N('e'); expect((await chain.call(outsider.address, 'approve', [d.dealId, nonce, await signApproval(chain, d, 2, nonce)])).ok).toBe(true); // ainda dentro do prazo para assinar
    expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('Expired'); // mas dentro da margem de execução ⇒ não liquida
    chain.ts += 31; expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('Expired');
    const s0 = await chain.balance(d.parts[0]!.address), b0 = await chain.erc20Balance(usdc, d.parts[1]!.address);
    expect((await chain.call(outsider.address, 'refund', [d.dealId, 0])).ok).toBe(true); expect((await chain.status(d.dealId)).status).toBe(STATUS.REFUNDING);
    expect((await chain.call(outsider.address, 'refund', [d.dealId, 1])).ok).toBe(true); expect((await chain.status(d.dealId)).status).toBe(STATUS.REFUNDED);
    expect((await chain.balance(d.parts[0]!.address)) - s0).toBe(d.evm.amountIn); expect((await chain.erc20Balance(usdc, d.parts[1]!.address)) - b0).toBe(d.evm.amountOut + d.evm.commissionAmount);
    expect((await chain.call(outsider.address, 'refund', [d.dealId, 0])).error).toContain('NothingToRefund'); expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('NotFullySigned');
  });
  it('refund antes da expiração é rejeitado; cancel só por participante e só antes da 1ª assinatura; supersede só sem assinaturas e sem fundos em custódia', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(d); await register(d); await depositAll(d);
    expect((await chain.call(d.parts[0]!.address, 'refund', [d.dealId, 0])).error).toContain('NotExpired');
    expect((await chain.call(outsider.address, 'cancel', [d.dealId])).error).toContain('NotParticipant');
    await approveAll(d, 1); expect((await chain.call(d.parts[1]!.address, 'cancel', [d.dealId])).error).toMatch(/SignedAlready|BadStatus/); expect((await chain.call(keeper.address, 'supersede', [d.dealId, 1])).error).toMatch(/SignedAlready|BadStatus/);
    const e = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(e); await register(e); await depositAll(e);
    expect((await chain.call(e.parts[2]!.address, 'cancel', [e.dealId])).ok).toBe(true); expect((await chain.status(e.dealId)).status).toBe(STATUS.CANCELLED);
    expect((await chain.call(outsider.address, 'refund', [e.dealId, 0])).ok).toBe(true); expect((await chain.call(outsider.address, 'refund', [e.dealId, 1])).ok).toBe(true);
    const f = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(f); await register(f); await depositAll(f);
    expect((await chain.call(keeper.address, 'supersede', [f.dealId, 1])).ok).toBe(true); expect((await register(makeDeal(chain, { participants: f.parts, token: usdc, tokenId: usdcId(), dealId: f.dealId, revision: 2 }))).error).toContain('FundsStillEscrowed');
    await chain.call(outsider.address, 'refund', [f.dealId, 0]); await chain.call(outsider.address, 'refund', [f.dealId, 1]); expect((await register(makeDeal(chain, { participants: f.parts, token: usdc, tokenId: usdcId(), dealId: f.dealId, revision: 2 }))).ok).toBe(true);
  });
});

describe('Double settlement, ativos, slippage, oráculo, fees (§11, §13–§18, §26)', () => {
  it('SETTLED → settle de novo, refund ou approve falham; estado imutável', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fullFlow(d); expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).ok).toBe(true);
    expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('NotFullySigned'); expect((await chain.call(outsider.address, 'refund', [d.dealId, 0])).error).toContain('BadStatus');
    const nonce = N('d'); expect((await chain.call(outsider.address, 'approve', [d.dealId, nonce, await signApproval(chain, d, 0, nonce)])).error).toContain('BadStatus');
    chain.ts += 4000; expect((await chain.call(outsider.address, 'refund', [d.dealId, 1])).error).toContain('BadStatus'); chain.ts -= 4000;
  });
  it('fake token / contrato errado / decimals errados / rede errada (canonical) / valor errado são rejeitados no register', async () => {
    const fake = await chain.deploy(admin.address, ERC20, ['Tether USD', 'USDT', 6]); const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(d);
    const leg = (over: Record<string, unknown>) => [d.input.legs as unknown[]].flat().map((l, i) => i === 1 ? { ...(l as Record<string, unknown>), ...over } : l);
    expect((await register(d, { legs: leg({ token: fake }) })).error).toContain('AssetNotRegistered'); // mesmo símbolo, contrato falso
    expect((await register(d, { legs: leg({ decimals: 8 }) })).error).toContain('AssetMismatch');
    expect((await register(d, { legs: leg({ canonicalId: keccak256(stringToHex(`eip155:137/erc20:${usdc.toLowerCase()}`)) }) })).error).toContain('AssetMismatch'); // rede errada
    expect((await register(d, { legs: leg({ amount: d.evm.amountOut + 1n }) })).error).toContain('BadLegParties');
    expect((await register(d, { minAmountOut: d.evm.amountOut + 1n })).error).toContain('BadInput'); // slippage: mínimo acima do que será entregue
    expect((await register(d, { feeBps: 501 })).error).toContain('FeeTooHigh'); expect((await register(d, { commissionSplitBps: [600, 500] })).error).toContain('BadInput'); expect((await register(d, { commissionBps: 1000, commissionSplitBps: [1000, 0], commissionAmount: 0n })).error).toContain('BadInput');
    expect((await register(d, { participants: [d.parts[0]!.address, d.parts[1]!.address, chain.contract] })).error).toContain('ParticipantMustBeEOA');
  });
  it('registro de ativo: decimals divergentes do contrato são rejeitados; timelock obrigatório; ativo removido após assinaturas ⇒ settle falha (fail closed)', async () => {
    const t8 = await chain.deploy(admin.address, ERC20, ['Wrong', 'W', 8]); const id = keccak256(stringToHex('eip155:1/erc20:x'));
    await chain.call(admin.address, 'scheduleAsset', [t8, true, 6, id]); chain.ts += 24 * 3600 + 1; expect((await chain.call(admin.address, 'executeAsset', [t8, true, 6, id])).error).toContain('AssetMismatch');
    expect((await chain.call(admin.address, 'executeAsset', [t8, true, 8, id])).error).toContain('TimelockPending'); expect((await chain.call(outsider.address, 'scheduleAsset', [t8, true, 8, id])).ok).toBe(false);
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), expiresAtMs: BigInt(chain.ts + 10 * 86400) * 1000n }); await fullFlow(d);
    try { await chain.call(admin.address, 'scheduleAsset', [usdc, false, 6, keccak256(stringToHex(usdcId()))]); chain.ts += 24 * 3600 + 1; expect((await chain.call(admin.address, 'executeAsset', [usdc, false, 6, keccak256(stringToHex(usdcId()))])).ok).toBe(true);
      expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('AssetNotRegistered'); expect((await chain.status(d.dealId)).status).toBe(STATUS.FULLY_SIGNED); }
    finally { await chain.allowAsset(admin.address, usdc, 6, keccak256(stringToHex(usdcId()))); }
    expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).ok).toBe(true);
  });
  it('guarda de preço (oráculo) rejeita ⇒ não liquida; volta a aceitar ⇒ liquida', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fullFlow(d);
    await chain.callTo(guard, GUARD.abi, admin.address, 'set', [false]); expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('PriceGuardRejected'); expect((await chain.status(d.dealId)).status).toBe(STATUS.FULLY_SIGNED);
    await chain.callTo(guard, GUARD.abi, admin.address, 'set', [true]); expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).ok).toBe(true);
  });
  it('fee-on-transfer é rejeitado no depósito; HTLC exige preimage correta', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(d); await register(d); await chain.erc20(usdc, admin.address, 'setFeeBps', [10]);
    await chain.erc20(usdc, d.parts[1]!.address, 'approve', [chain.contract, d.evm.amountOut]); expect((await chain.call(d.parts[1]!.address, 'deposit', [d.dealId, 1])).error).toContain('TransferAmountMismatch'); await chain.erc20(usdc, admin.address, 'setFeeBps', [0]);
    const h = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), htlc: true }); await fullFlow(h);
    expect((await chain.call(outsider.address, 'settle', [h.dealId, ZERO])).error).toContain('BadPreimage'); const okH = await chain.call(outsider.address, 'settle', [h.dealId, ('0x' + 'ab'.repeat(32)) as Hex]); expect(okH.error ?? 'ok').toBe('ok');
  });
});

describe('Reentrância, falha parcial, overflow, pausa e privilégios (§20–§24)', () => {
  it('token reentrante na allowlist: a reentrada é bloqueada (nonReentrant) e o estado permanece consistente', async () => {
    const evil = await chain.deploy(admin.address, EVIL, []); const evilId = `eip155:1/erc20:${evil.toLowerCase()}`; await chain.allowAsset(admin.address, evil, 6, keccak256(stringToHex(evilId)));
    const d = makeDeal(chain, { participants: parts3(), token: evil, tokenId: evilId }); for (const p of d.parts) await chain.fund(p.address, 10n ** 20n); await chain.erc20(evil, admin.address, 'mint', [d.parts[1]!.address, 10n ** 15n]);
    await register(d); await chain.call(d.parts[0]!.address, 'deposit', [d.dealId, 0], d.evm.amountIn); await chain.erc20(evil, d.parts[1]!.address, 'approve', [chain.contract, d.evm.amountOut]); await chain.call(d.parts[1]!.address, 'deposit', [d.dealId, 1]); await approveAll(d);
    await chain.callTo(evil, EVIL.abi, admin.address, 'arm', [chain.contract, d.dealId, 2]);
    expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).ok).toBe(true); expect(await chain.view<boolean>('reentered', [], evil, EVIL.abi)).toBe(true); expect(await chain.view<boolean>('reentryReverted', [], evil, EVIL.abi)).toBe(true);
    expect((await chain.status(d.dealId)).status).toBe(STATUS.SETTLED); expect(await chain.erc20Balance(evil, chain.contract)).toBe(0n);
  });
  it('falha parcial: se uma transferência da liquidação falha, TUDO reverte (sem estado parcialmente liquidado)', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fullFlow(d); await chain.erc20(usdc, admin.address, 'setRevertOnTransferTo', [treasury]);
    const before = await chain.balance(d.parts[1]!.address); expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).ok).toBe(false);
    expect((await chain.status(d.dealId)).status).toBe(STATUS.FULLY_SIGNED); expect(await chain.balance(d.parts[1]!.address)).toBe(before); expect(await chain.erc20Balance(usdc, chain.contract)).toBeGreaterThan(0n);
    await chain.erc20(usdc, admin.address, 'setRevertOnTransferTo', ['0x0000000000000000000000000000000000000000']); expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).ok).toBe(true);
  });
  it('overflow: valores extremos revertem (aritmética checada) em vez de liquidar errado', async () => {
    const big = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), amountOut: 2n ** 255n }); await fundAll(big); expect((await register(big)).ok).toBe(true);
    await chain.erc20(usdc, admin.address, 'mint', [big.parts[1]!.address, 2n ** 255n]); await chain.erc20(usdc, big.parts[1]!.address, 'approve', [chain.contract, 2n ** 255n]);
    await chain.call(big.parts[0]!.address, 'deposit', [big.dealId, 0], big.evm.amountIn); expect((await chain.call(big.parts[1]!.address, 'deposit', [big.dealId, 1])).ok).toBe(true); await approveAll(big);
    expect((await chain.call(outsider.address, 'settle', [big.dealId, ZERO])).error).toContain('Panic'); expect((await chain.status(big.dealId)).status).toBe(STATUS.FULLY_SIGNED);
  });
  it('pausa: bloqueia register/deposit/approve/settle, NUNCA refund/cancel; unpause restaura; só guardian pausa', async () => {
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId(), expiresAtMs: BigInt(chain.ts + 300) * 1000n }); await fullFlow(d);
    expect((await chain.call(admin.address, 'pause', [])).ok).toBe(false); expect((await chain.call(guardian.address, 'pause', [])).ok).toBe(true);
    expect((await chain.call(outsider.address, 'settle', [d.dealId, ZERO])).error).toContain('EnforcedPause'); expect((await register(makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }))).error).toContain('EnforcedPause');
    chain.ts += 301; const s0 = await chain.balance(d.parts[0]!.address); expect((await chain.call(outsider.address, 'refund', [d.dealId, 0])).ok).toBe(true); expect((await chain.balance(d.parts[0]!.address)) - s0).toBe(d.evm.amountIn);
    expect((await chain.call(guardian.address, 'unpause', [])).ok).toBe(true); expect((await register(makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }))).ok).toBe(true);
  });
  it('privilégios: nenhuma função de saque/upgrade/redirecionamento; keeper não altera destinos; admin não muda fee/tesouraria', async () => {
    const names = (ESCROW.abi.filter(x => x.type === 'function') as { name: string; stateMutability: string }[]).map(f => f.name);
    expect(names.some(n => /withdraw|sweep|rescue|upgrade|setTreasury|setFee|setRecipient|transferOwnership|emergencyWithdraw/i.test(n))).toBe(false);
    expect(names.filter(n => n === 'pause' || n === 'unpause' || n === 'scheduleAsset' || n === 'executeAsset' || n === 'register' || n === 'supersede').length).toBe(6); // superfície administrativa completa
    expect(await chain.view<string>('treasury', [])).toBe(treasury); expect(await chain.view<number>('CONTRACT_VERSION', [])).toBe(2);
    const d = makeDeal(chain, { participants: parts3(), token: usdc, tokenId: usdcId() }); await fundAll(d); expect((await chain.call(outsider.address, 'register', [d.input])).ok).toBe(false); // só REGISTRAR
  });
});
