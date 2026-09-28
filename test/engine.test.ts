import { describe, it, expect } from 'vitest';
import { makeApp, prepareDeal, fullySign, signAs, solWallet, evmWallet, btcWallet, participantsOf, ASSETS, type Parts } from './helpers.js';
import { DomainError } from '../src/domain/errors.js';
import { SIGNING_ORDER } from '../src/domain/types.js';
import { LOCAL_TOKENS } from '../src/app.js';

const solParts = (): Parts => ({ SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() });
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'OK'; } catch (e) { return (e as DomainError).code ?? (e as Error).message; } };

describe('Deal Engine — criação e verificações', () => {
  it('cria Deal com ID, participantes, ativos, quantias, preço, deságio, fees, rota, expiração, nonce, status e dealHash', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts);
    expect(d.state).toBe('LIQUIDITY_VERIFIED'); expect(d.terms).not.toBeNull(); expect(d.hash!.dealHash).toHaveLength(64);
    const t = d.terms!; expect(t.dealId).toBe(d.id); expect(t.participants).toHaveLength(3); expect(t.requiredSignatures).toBe(3); expect(t.legs[0]!.amountBase).toBe('250000000000'); expect(BigInt(t.legs[1]!.amountBase)).toBeGreaterThan(0n);
    expect(t.pricing.discountBps).toBe(150); expect(t.pricing.platformFeeBps).toBe(3); expect(t.route.routeId).toMatch(/^RT-ESCROW_NN/); expect(t.expiresAt).toBe(d.expiresAt); expect(t.dealNonce).toHaveLength(32);
    expect(d.onChain.solana?.registered).toBe(true); await app.close();
  });
  it('4 participantes ⇒ 4 assinaturas obrigatórias; 3 assinaturas não liquidam', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts: Parts = { ...solParts(), PAYMASTER_2: solWallet() }; const d = await prepareDeal(app, parts);
    expect(d.requiredSignatures).toBe(4); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
    await signAs(app, d.id, 'SELLER', parts.SELLER); await signAs(app, d.id, 'PAYMASTER_1', parts.PAYMASTER_1); const r = await signAs(app, d.id, 'PAYMASTER_2', parts.PAYMASTER_2!);
    expect(r.count).toBe(3); expect(r.state).toBe('AWAITING_SIGNATURES'); expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_NOT_ALLOWED');
    const r4 = await signAs(app, d.id, 'BUYER', parts.BUYER); expect(r4.count).toBe(4); expect(r4.state).toBe('SETTLEMENT_VALIDATION'); await app.close();
  });
  it('token falso / contrato incorreto: fora do registro canônico é rejeitado mesmo com símbolo igual', async () => {
    const { app } = await makeApp(); const parts = solParts();
    expect(await code(app.deals.create({ assetIn: ASSETS.SOL, assetOut: { network: 'solana', chainId: 'localnet', contractOrMint: 'FAKEUSDC11111111111111111111111111111111111' }, amountInBase: '1000000000', participants: participantsOf(parts) }, parts.SELLER.address))).toBe('ASSET_NOT_CANONICAL');
    expect(await code(app.deals.create({ assetIn: ASSETS.SOL, assetOut: { ...ASSETS.USDC_SOL, chainId: 'mainnet-beta' }, amountInBase: '1000000000', participants: participantsOf(parts) }, parts.SELLER.address))).toBe('ASSET_NOT_CANONICAL');
    await app.close();
  });
  it('contrato canônico cujo bytecode/mint authority mudou on-chain falha na verificação', async () => {
    const { app } = await makeApp(); const parts: Parts = { SELLER: evmWallet(), BUYER: evmWallet(), PAYMASTER_1: evmWallet() };
    app.local!.evm.addToken({ contract: LOCAL_TOKENS.usdtEth, symbol: 'USDT', decimals: 6, standard: 'ERC-20', codeHash: 'upgraded-malicious' });
    expect(await code(prepareDeal(app, parts, { assetIn: ASSETS.ETH, assetOut: ASSETS.USDT_ETH, amountInBase: '1000000000000000000' }))).toBe('ASSET_VERIFICATION_FAILED'); await app.close();
  });
  it('wallet incorreta (endereço malformado) e network incorreta (vendedor fora da rede do ativo) são rejeitadas', async () => {
    const { app } = await makeApp(); const parts = solParts();
    expect(await code(app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: [...participantsOf(parts).slice(0, 2), { role: 'PAYMASTER_1', network: 'ethereum', chainId: '31337', address: '0xNAO-E-UM-ENDERECO-VALIDO-0000000000000' }] }, parts.SELLER.address))).toBe('WALLET_INVALID');
    const evm = evmWallet(); expect(await code(app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: [{ role: 'SELLER', network: 'ethereum', chainId: '31337', address: evm.address }, ...participantsOf(parts).slice(1)] }, evm.address))).toBe('WALLET_INVALID');
    expect(await code(app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: [{ role: 'SELLER', network: 'solana', chainId: 'mainnet-beta', address: parts.SELLER.address }, ...participantsOf(parts).slice(1)] }, parts.SELLER.address))).toBe('WALLET_INVALID');
    const d = await app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: participantsOf(parts) }, parts.SELLER.address);
    expect(await code(app.deals.connectWallet(d.id, 'BUYER', solWallet().address, parts.BUYER.address))).toBe('WALLET_INVALID'); await app.close();
  });
  it('liquidez insuficiente bloqueia antes da assinatura', async () => {
    const { app } = await makeApp(); const parts = solParts(); app.sources.liquidity.forEach(s => { (s as unknown as { depths: Record<string, number> }).depths = Object.fromEntries(Object.keys((s as unknown as { depths: Record<string, number> }).depths).map(k => [k, 100])); });
    const r = await code(prepareDeal(app, parts)); expect(r).toBe('LIQUIDITY_INSUFFICIENT'); await app.close();
  });
  it('preço anormal (uma fonte desvia 5%) ⇒ PRICE_ANOMALY e evento de risco', async () => {
    const { app } = await makeApp(); const parts = solParts(); app.sources.price[0]!.skew = 1.05;
    expect(await code(prepareDeal(app, parts))).toBe('PRICE_ANOMALY'); await app.close();
  });
  it('falha de oracle: com 2 fontes fora, abaixo do mínimo ⇒ PRICE_UNAVAILABLE; com 1 fora ⇒ segue', async () => {
    const { app } = await makeApp(); const parts = solParts(); app.sources.price[0]!.down = true; app.sources.price[1]!.down = true;
    expect(await code(prepareDeal(app, parts))).toBe('PRICE_UNAVAILABLE'); app.sources.price[1]!.down = false;
    const d = await prepareDeal(app, solParts()); expect(d.state).toBe('LIQUIDITY_VERIFIED'); await app.close();
  });
  it('falha de liquidity source: uma venue fora é tolerada; todas fora ⇒ LIQUIDITY_UNAVAILABLE', async () => {
    const { app } = await makeApp(); app.sources.liquidity[0]!.down = true; const d = await prepareDeal(app, solParts()); expect(d.state).toBe('LIQUIDITY_VERIFIED');
    app.sources.liquidity.forEach(s => { s.down = true; }); expect(await code(prepareDeal(app, solParts()))).toBe('LIQUIDITY_UNAVAILABLE'); await app.close();
  });
  it('falha de RPC na verificação ⇒ ADAPTER_UNAVAILABLE; Deal não avança', async () => {
    const { app } = await makeApp(); const parts = solParts(); app.local!.solana.faults.rpcDown = true;
    expect(await code(prepareDeal(app, parts))).toBe('ADAPTER_UNAVAILABLE'); await app.close();
  });
  it('rota inviável (escrow Ethereum com Pay Master de chave Ed25519) ⇒ ROUTE_NOT_VIABLE', async () => {
    const { app } = await makeApp(); const parts: Parts = { SELLER: evmWallet(), BUYER: evmWallet(), PAYMASTER_1: solWallet() };
    expect(await code(prepareDeal(app, parts, { assetIn: ASSETS.ETH, assetOut: ASSETS.USDC_ETH, amountInBase: '1000000000000000000' }))).toBe('ROUTE_NOT_VIABLE'); await app.close();
  });
});

describe('Signature Engine', () => {
  it('assinatura inválida (bytes aleatórios) é rejeitada', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    const env = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address);
    expect(await code(app.deals.submitSignature(d.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'ed25519', signature: '5'.repeat(88), nonce: env.payload.nonce }, parts.SELLER.address))).toBe('SIGNATURE_INVALID');
    expect((await app.deals.get(d.id)).validSignatures).toBe(0); await app.close();
  });
  it('assinatura de carteira não participante / participante incorreto é rejeitada', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    const outsider = solWallet(); expect(await code(app.deals.envelope(d.id, 'SELLER', outsider.address))).toBe('FORBIDDEN');
    const env = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address); const sigByPm = await parts.PAYMASTER_1.sign(env);
    expect(await code(app.deals.submitSignature(d.id, { role: 'SELLER', signer: parts.PAYMASTER_1.address, scheme: 'ed25519', signature: sigByPm, nonce: env.payload.nonce }, parts.PAYMASTER_1.address))).toBe('SIGNATURE_WRONG_SIGNER');
    // assinatura válida do Pay Master enviada como se fosse do Vendedor (mesmo nonce) — não fecha o papel
    expect(await code(app.deals.submitSignature(d.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'ed25519', signature: sigByPm, nonce: env.payload.nonce }, parts.SELLER.address))).toBe('SIGNATURE_INVALID'); await app.close();
  });
  it('assinatura de outro Deal e assinatura com parâmetros diferentes são rejeitadas', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d1 = await prepareDeal(app, parts); const d2 = await prepareDeal(app, parts);
    for (const d of [d1, d2]) { await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); }
    const env1 = await app.deals.envelope(d1.id, 'SELLER', parts.SELLER.address); const sig1 = await parts.SELLER.sign(env1);
    expect(await code(app.deals.submitSignature(d2.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'ed25519', signature: sig1, nonce: env1.payload.nonce }, parts.SELLER.address))).toBe('NONCE_INVALID');
    const env2 = await app.deals.envelope(d2.id, 'SELLER', parts.SELLER.address);
    expect(await code(app.deals.submitSignature(d2.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'ed25519', signature: sig1, nonce: env2.payload.nonce }, parts.SELLER.address))).toBe('SIGNATURE_INVALID');
    // parâmetros alterados no cliente (amountOut manipulado) ⇒ o servidor reconstrói o envelope pelos termos ⇒ inválida
    const r = await code(signAs(app, d1.id, 'SELLER', parts.SELLER, e => ({ ...e, message: e.message.replace(/"amountOut":"\d+"/, '"amountOut":"1"') }))); expect(r).toBe('SIGNATURE_INVALID'); await app.close();
  });
  it('assinatura duplicada não conta duas vezes e nonce não pode ser reutilizado', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    const env = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address); const sig = await parts.SELLER.sign(env); const s = { role: 'SELLER' as const, signer: parts.SELLER.address, scheme: 'ed25519' as const, signature: sig, nonce: env.payload.nonce };
    expect((await app.deals.submitSignature(d.id, s, parts.SELLER.address)).count).toBe(1);
    expect(await code(app.deals.submitSignature(d.id, s, parts.SELLER.address))).toBe('NONCE_INVALID');
    const r2 = await signAs(app, d.id, 'SELLER', parts.SELLER); expect(r2.count).toBe(1); // reassinatura substitui, não acumula
    expect((await app.deals.get(d.id)).signatures.filter(x => x.status === 'valid')).toHaveLength(1); await app.close();
  });
  it('assinatura expirada: após expiresAt a assinatura é rejeitada e a Deal expira', async () => {
    const { app, clock } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    const env = await app.deals.envelope(d.id, 'SELLER', parts.SELLER.address); const sig = await parts.SELLER.sign(env); clock.advance(3601_000);
    expect(await code(app.deals.submitSignature(d.id, { role: 'SELLER', signer: parts.SELLER.address, scheme: 'ed25519', signature: sig, nonce: env.payload.nonce }, parts.SELLER.address))).toBe('DEAL_EXPIRED');
    const after = await app.deals.get(d.id); expect(['EXPIRED', 'REFUNDING', 'REFUNDED']).toContain(after.state); expect(after.state).toBe('REFUNDED'); await app.close();
  });
  it('assinar antes de depositar é rejeitado (FUNDING_REQUIRED)', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address);
    expect(await code(signAs(app, d.id, 'SELLER', parts.SELLER))).toBe('FUNDING_REQUIRED'); await app.close();
  });
  it('ordem obrigatória: ninguém assina antes do anterior (Vendedor → PM1 → Comprador); a vez avança', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
    expect((await app.deals.get(d.id)).turnRole).toBe('SELLER');
    expect(await code(signAs(app, d.id, 'BUYER', parts.BUYER))).toBe('SIGNATURE_OUT_OF_ORDER');       // Comprador antes de todos
    expect(await code(signAs(app, d.id, 'PAYMASTER_1', parts.PAYMASTER_1))).toBe('SIGNATURE_OUT_OF_ORDER'); // PM1 antes do Vendedor
    await signAs(app, d.id, 'SELLER', parts.SELLER); expect((await app.deals.get(d.id)).turnRole).toBe('PAYMASTER_1');
    expect(await code(signAs(app, d.id, 'BUYER', parts.BUYER))).toBe('SIGNATURE_OUT_OF_ORDER');       // Comprador ainda espera PM1
    await signAs(app, d.id, 'PAYMASTER_1', parts.PAYMASTER_1); expect((await app.deals.get(d.id)).turnRole).toBe('BUYER');
    const r = await signAs(app, d.id, 'BUYER', parts.BUYER); expect(r.count).toBe(3); expect(r.state).toBe('SETTLEMENT_VALIDATION');
    expect((await app.deals.get(d.id)).turnRole).toBeNull(); await app.close();
  });
  it('janela rolante de 48h por assinante: se o da vez não assina em 48h, a Deal expira (turno)', async () => {
    const { app, clock } = await makeApp({ autoSettle: false }); const parts = solParts();
    const d = await prepareDeal(app, parts, { expiresInSec: 10 * 24 * 3600 }); await app.deals.open(d.id, parts.SELLER.address); // teto global folgado
    const opened = await app.deals.get(d.id); expect(opened.turnRole).toBe('SELLER'); expect(opened.turnExpiresAt).toBe(clock.now() + 48 * 3600 * 1000);
    clock.advance(48 * 3600 * 1000 + 1000); // Vendedor deixou passar as 48h dele
    expect(await app.deals.expireDue()).toContain(d.id); expect((await app.deals.get(d.id)).state).toBe('EXPIRED'); await app.close();
  });
  it('Deal alterada após assinaturas: assinaturas invalidadas (superseded), depósitos devolvidos, novo hash, nova revisão', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts); const h1 = d.hash!.dealHash; await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await signAs(app, d.id, 'SELLER', parts.SELLER); await signAs(app, d.id, 'PAYMASTER_1', parts.PAYMASTER_1);
    const amended = await app.deals.amend(d.id, { discountBps: 200 }, parts.SELLER.address);
    expect(amended.revision).toBe(2); expect(amended.validSignatures).toBe(0); expect(amended.hash!.dealHash).not.toBe(h1); expect(amended.signatures.every(s => s.status === 'superseded')).toBe(true);
    expect(amended.participants.find(p => p.role === 'SELLER')!.funding).toBe('PENDING'); expect(amended.refunds).toHaveLength(1); expect(app.local!.solana.balanceOf(parts.SELLER.address, null)).toBe(500000000000n);
    expect(amended.state).toBe('LIQUIDITY_VERIFIED'); await app.close();
  });
});

describe('Settlement Engine', () => {
  it('3/3 assinaturas + funding ⇒ SETTLED; fundos e fee chegam aos destinos', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); const t = d.terms!;
    const signed = await fullySign(app, d.id, parts); expect(signed.state).toBe('SETTLEMENT_VALIDATION');
    const rec = await app.settlement.settle(d.id); expect(rec.status).toBe('DONE'); const fin = await app.deals.get(d.id); expect(fin.state).toBe('SETTLED');
    const sol = app.local!.solana; expect(sol.balanceOf(parts.BUYER.address, null)).toBe(BigInt(t.legs[0]!.amountBase));
    const out = BigInt(t.legs[1]!.amountBase); const feeBps = BigInt(t.pricing.platformFeeBps); expect(sol.balanceOf(parts.SELLER.address, LOCAL_TOKENS.usdcSol)).toBe(out - out * feeBps / 10000n); expect(sol.balanceOf(app.config.TREASURY_ADDRESS, LOCAL_TOKENS.usdcSol)).toBe(out * feeBps / 10000n);
    expect(fin.settlement!.legs.every(l => l.step === 'FINAL' && l.txRef)).toBe(true); await app.close();
  });
  it('1 assinatura faltando ⇒ NÃO liquida; contrato também rejeita', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address); await signAs(app, d.id, 'SELLER', parts.SELLER); await signAs(app, d.id, 'PAYMASTER_1', parts.PAYMASTER_1);
    expect((await app.deals.get(d.id)).validSignatures).toBe(2); expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_NOT_ALLOWED');
    const sigs = (await app.deals.get(d.id)).signatures.map(s => ({ role: s.role, signer: s.signer, scheme: s.scheme, signature: s.signature, nonce: s.nonce }));
    expect(await code(app.local!.solana.settle(d.id, 0, sigs))).toBe('SETTLEMENT_NOT_ALLOWED'); expect((await app.deals.get(d.id)).state).toBe('AWAITING_SIGNATURES'); await app.close();
  });
  it('Deal executada duas vezes: segunda chamada não emite transação (idempotente) e o contrato rejeita', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    const [a, b] = await Promise.all([app.settlement.settle(d.id), app.settlement.settle(d.id)]); expect(a.id).toBe(b.id); expect(a.status).toBe('DONE');
    const third = await app.settlement.settle(d.id); expect(third.id).toBe(a.id); expect((await app.store.listDealEvents(d.id)).filter(e => e.type === 'settlement.leg.submitted')).toHaveLength(1); // uma transação por cadeia; nenhuma nova
    const sigs = (await app.deals.get(d.id)).signatures.map(s => ({ role: s.role, signer: s.signer, scheme: s.scheme, signature: s.signature, nonce: s.nonce }));
    expect(await code(app.local!.solana.settle(d.id, 0, sigs))).toBe('SETTLEMENT_ALREADY_EXECUTED');
    const sol = app.local!.solana; const t = d.terms!; expect(sol.balanceOf(parts.BUYER.address, null)).toBe(BigInt(t.legs[0]!.amountBase)); await app.close();
  });
  it('Deal expirada nunca liquida: expiração ⇒ EXPIRED → REFUNDING → REFUNDED, saldos devolvidos', async () => {
    const { app, clock } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address);
    await app.deals.fund(d.id, 'SELLER', parts.SELLER.address); await app.deals.fund(d.id, 'BUYER', parts.BUYER.address); await signAs(app, d.id, 'SELLER', parts.SELLER); await signAs(app, d.id, 'PAYMASTER_1', parts.PAYMASTER_1);
    clock.advance(3601_000); const ids = await app.deals.expireDue(); expect(ids).toContain(d.id);
    const fin = await app.deals.get(d.id); expect(fin.state).toBe('REFUNDED'); expect(fin.refunds.filter(r => r.status === 'REFUNDED')).toHaveLength(2);
    expect(app.local!.solana.balanceOf(parts.SELLER.address, null)).toBe(500000000000n); expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_NOT_ALLOWED'); await app.close();
  });
  it('expira entre N/N e a execução (margem) ⇒ EXPIRED, sem transação de liquidação', async () => {
    const { app, clock } = await makeApp({ autoSettle: false, env: { EXEC_MARGIN_MS: '60000' } }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    clock.advance(3600_000 - 30_000); expect(await code(app.settlement.settle(d.id))).toBe('DEAL_EXPIRED'); let fin = await app.deals.get(d.id); expect(fin.state).toBe('REFUNDING'); expect(fin.settlement).toBeNull(); // on-chain o timelock ainda não venceu
    clock.advance(31_000); fin = await app.deals.retryRefunds(d.id); expect(fin.state).toBe('REFUNDED'); await app.close();
  });
  it('preço alterado além da banda depois das assinaturas ⇒ INVALIDA (BLOCKED + reembolso), nunca executa com preço antigo', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    app.sources.price.forEach(s => { s.setPrice('solana:localnet/slip44:501', 151.2 * 1.03); }); expect(await code(app.settlement.settle(d.id))).toBe('PRICE_ANOMALY');
    const fin = await app.deals.get(d.id); expect(fin.state).toBe('BLOCKED'); expect(fin.refunds.filter(r => r.status === 'REFUNDED')).toHaveLength(2); expect(app.local!.solana.balanceOf(parts.SELLER.address, null)).toBe(500000000000n); await app.close();
  });
  it('rota alterada (contrato de escrow trocado) ⇒ ROUTE_CHANGED e bloqueio', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    (app.local!.solana as unknown as { escrow: string }).escrow = 'VerumEscrowV2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; expect(await code(app.settlement.settle(d.id))).toBe('ROUTE_CHANGED'); expect((await app.deals.get(d.id)).state).toBe('BLOCKED'); await app.close();
  });
  it('falha de RPC durante a validação ⇒ não liquida e não perde estado', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    app.local!.solana.faults.rpcDown = true; expect(await code(app.settlement.settle(d.id))).toBe('ADAPTER_UNAVAILABLE'); expect((await app.deals.get(d.id)).state).toBe('SETTLEMENT_VALIDATION');
    app.local!.solana.faults.rpcDown = false; expect((await app.settlement.settle(d.id)).status).toBe('DONE'); await app.close();
  });
  it('falha durante settlement (leg revertida) ⇒ BLOCKED, reembolso da leg em escrow, sem rota alternativa', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    app.local!.solana.faults.settleReverts = true; expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_FAILED');
    const fin = await app.deals.get(d.id); expect(fin.state).toBe('BLOCKED'); expect(fin.settlement!.status).toBe('FAILED'); expect(fin.refunds.filter(r => r.status === 'REFUNDED')).toHaveLength(2);
    expect(app.local!.solana.balanceOf(parts.SELLER.address, null)).toBe(500000000000n); expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_NOT_ALLOWED'); await app.close();
  });
  it('recovery: processo cai após enviar a leg on-chain; ao retomar reconhece a transação e conclui sem reenviar', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    // simula queda: liquida diretamente no "contrato" (como se o processo tivesse enviado e morrido antes de persistir)
    const sigs = (await app.deals.get(d.id)).signatures.map(s => ({ role: s.role, signer: s.signer, scheme: s.scheme, signature: s.signature, nonce: s.nonce }));
    await app.local!.solana.settle(d.id, 0, sigs); const before = app.local!.solana.balanceOf(parts.BUYER.address, null);
    const out = await app.settlement.recover(); expect(out.find(x => x.dealId === d.id)?.action).toBe('settled');
    const fin = await app.deals.get(d.id); expect(fin.state).toBe('SETTLED'); expect(app.local!.solana.balanceOf(parts.BUYER.address, null)).toBe(before); expect(fin.settlement!.legs[0]!.txRef).toBeTruthy(); await app.close();
  });
  it('reorg após confirmação parcial ⇒ BLOCKED e incidente de risco', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    app.local!.solana.faults.reorgAfterSettle = true; expect(await code(app.settlement.settle(d.id))).toBe('SETTLEMENT_FAILED'); expect((await app.deals.get(d.id)).state).toBe('BLOCKED'); expect((await app.store.listRiskEvents(d.id)).some(r => r.rule.includes('leg-failure'))).toBe(true); await app.close();
  });
  it('refund pendente por RPC fora volta a ser processado (retryRefunds)', async () => {
    const { app, clock } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    clock.advance(3601_000); app.local!.solana.faults.rpcDown = true; await app.deals.expireDue(); let fin = await app.deals.get(d.id); expect(fin.state).toBe('REFUNDING'); expect(fin.refunds[0]!.status).toBe('PENDING');
    app.local!.solana.faults.rpcDown = false; fin = await app.deals.retryRefunds(d.id); expect(fin.state).toBe('REFUNDED'); expect(app.local!.solana.balanceOf(parts.SELLER.address, null)).toBe(500000000000n); await app.close();
  });
  it('liquidação automática ao completar N/N (evento settle)', async () => {
    const { app } = await makeApp(); const parts = solParts(); const d = await prepareDeal(app, parts); await fullySign(app, d.id, parts);
    for (let i = 0; i < 50 && (await app.deals.get(d.id)).state !== 'SETTLED'; i++) await new Promise(r => setTimeout(r, 20));
    expect((await app.deals.get(d.id)).state).toBe('SETTLED'); await app.close();
  });
  it('cancelamento antes de FULLY_SIGNED devolve depósitos; depois de FULLY_SIGNED é proibido', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts = solParts(); const d = await prepareDeal(app, parts); await app.deals.open(d.id, parts.SELLER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    expect(await code(app.deals.cancel(d.id, solWallet().address))).toBe('FORBIDDEN'); const c = await app.deals.cancel(d.id, parts.BUYER.address); expect(c.state).toBe('CANCELLED'); expect(app.local!.solana.balanceOf(parts.SELLER.address, null)).toBe(500000000000n);
    const d2 = await prepareDeal(app, parts); await fullySign(app, d2.id, parts); expect(await code(app.deals.cancel(d2.id, parts.SELLER.address))).toBe('ILLEGAL_TRANSITION'); await app.close();
  });
  it('carteira em lista de bloqueio ⇒ BLOCKED no screening', async () => {
    const bad = solWallet(); const { app } = await makeApp({ denylist: [bad.address] }); const parts: Parts = { SELLER: solWallet(), BUYER: bad, PAYMASTER_1: solWallet() };
    const d = await app.deals.create({ assetIn: ASSETS.SOL, assetOut: ASSETS.USDC_SOL, amountInBase: '1000000000', participants: participantsOf(parts) }, parts.SELLER.address);
    const after = await app.deals.connectWallet(d.id, 'BUYER', bad.address, bad.address); expect(after.state).toBe('BLOCKED'); expect(after.risk?.rule).toContain('wallet-screening'); await app.close();
  });
});

describe('Multichain: EVM (EIP-712) e Bitcoin (HTLC)', () => {
  it('Deal ETH → USDC em Ethereum com 3 carteiras EVM assinando EIP-712 liquida', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts: Parts = { SELLER: evmWallet(), BUYER: evmWallet(), PAYMASTER_1: evmWallet() };
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.ETH, assetOut: ASSETS.USDC_ETH, amountInBase: '12000000000000000000' }); expect(d.terms!.route.routeId).toBe('RT-ESCROW_NN-ETHEREUM-ETHEREUM');
    await fullySign(app, d.id, parts); expect((await app.settlement.settle(d.id)).status).toBe('DONE'); expect(app.local!.evm.balanceOf(parts.BUYER.address, null)).toBe(12000000000000000000n); await app.close();
  });
  it('Deal BTC → USDC(Solana) por HTLC: leg de contrato financiada primeiro, preimage revelada no settle, claim BTC pelo comprador', async () => {
    const { app } = await makeApp({ autoSettle: false }); const parts: Parts = { SELLER: btcWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.BTC, assetOut: ASSETS.USDC_SOL, amountInBase: '75000000' }); expect(d.terms!.route.kind).toBe('HTLC'); expect(d.terms!.route.htlcHash).toHaveLength(64);
    await app.deals.open(d.id, parts.SELLER.address);
    expect(await code(app.deals.fund(d.id, 'SELLER', parts.SELLER.address))).toBe('FUNDING_REQUIRED'); // BTC só depois da leg de contrato
    await app.deals.fund(d.id, 'BUYER', parts.BUYER.address); await app.deals.fund(d.id, 'SELLER', parts.SELLER.address);
    for (const role of SIGNING_ORDER) { const w = parts[role]; if (w) await signAs(app, d.id, role, w); }
    const rec = await app.settlement.settle(d.id); expect(rec.status).toBe('DONE'); expect((await app.deals.get(d.id)).state).toBe('SETTLED');
    expect(await app.local!.solana.revealedPreimage(d.id)).toBeTruthy(); expect(app.local!.bitcoin.balanceOf(parts.BUYER.address, null)).toBe(75000000n); await app.close();
  });
});
