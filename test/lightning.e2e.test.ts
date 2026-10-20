/**
 * Fase 4b E2E — o fluxo LIGHTNING_SWAP de ponta a ponta PELO MOTOR (DealEngine + settlement + os
 * dois adapters: LocalChainAdapter evm para a perna USDT + LightningLegAdapter para a perna BTC,
 * com o LightningSimulator como nó). Prova:
 *  - cria a deal com o htlcHash do COMPRADOR (route.kind = LIGHTNING_SWAP; Vendedor não financia);
 *  - Comprador deposita USDT; todos assinam;
 *  - liquidação: a perna lightning paga a invoice PRIMEIRO (revela R), o contrato settla com R.
 *  - resultado: deal SETTLED, preimage revelada, liquidez outbound do nó caiu pelo valor entregue.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeApp, evmWallet, signAs } from './helpers.js';
import { LOCAL_TOKENS } from '../src/app.js';
import { LightningSimulator } from '../src/adapters/lightning/simulator.js';
import { SIGNING_ORDER, type Role } from '../src/domain/types.js';


describe('E2E LIGHTNING_SWAP — BTC via Lightning ⇄ USDT no escrow', () => {
  it('cria a deal (htlcHash do comprador) → deposita USDT → assina → paga LN → settla', async () => {
    // Nó da mesa (market-maker). O "Comprador" gera R e a invoice; semeamos R no nó p/ o pagamento revelar.
    const ln = new LightningSimulator(1_000_000n);
    const R = bytesToHex(randomBytes(32)); const H = ln.seedPreimage(R);
    const amountSat = 50_000n;
    const inv = await ln.addInvoice(H, amountSat, 'swap-e2e');

    const { app } = await makeApp({ autoSettle: false, lightning: ln });
    // Participantes assinam no EVM (tesouraria/vendedor, comprador, PM1). O Comprador deposita USDT.
    const seller = evmWallet(); const buyer = evmWallet(); const pm1 = evmWallet();
    app.local!.evm.mint(buyer.address, LOCAL_TOKENS.usdtEth, 10n ** 12n);

    let deal = await app.deals.create({
      assetIn: { network: 'lightning', chainId: 'ln', contractOrMint: null },        // BTC via Lightning (do Vendedor)
      assetOut: { network: 'ethereum', chainId: '31337', contractOrMint: LOCAL_TOKENS.usdtEth }, // USDT (do Comprador)
      amountInBase: amountSat.toString(), discountBps: 0, maxSlippageBps: 100, maxPriceDriftBps: 500, expiresInSec: 3600,
      participants: [
        { role: 'SELLER', network: 'ethereum', chainId: '31337', address: seller.address },
        { role: 'PAYMASTER_1', network: 'ethereum', chainId: '31337', address: pm1.address },
        { role: 'BUYER', network: 'ethereum', chainId: '31337', address: buyer.address },
      ],
      lightningHtlcHash: H, lightningInvoice: inv.bolt11,
    }, seller.address);

    for (const [role, w] of [['PAYMASTER_1', pm1], ['BUYER', buyer]] as [Role, typeof buyer][]) deal = await app.deals.connectWallet(deal.id, role, w.address, w.address);
    deal = await app.deals.get(deal.id);
    expect(deal.terms!.route.kind).toBe('LIGHTNING_SWAP');
    expect(deal.terms!.route.htlcHash).toBe(H);                 // htlcHash = payment_hash do Comprador
    expect(deal.lightningHtlcHash).toBe(H);
    expect(deal.participants.find(p => p.role === 'SELLER')!.fundingRequired).toBe(false); // Vendedor não financia

    await app.deals.open(deal.id, seller.address);
    // Só o Comprador deposita (USDT); o Vendedor entrega o BTC na liquidação (via o nó).
    await app.deals.fund(deal.id, 'BUYER', buyer.address);
    const parts: Record<string, typeof buyer> = { SELLER: seller, PAYMASTER_1: pm1, BUYER: buyer };
    for (const role of SIGNING_ORDER) { const w = parts[role]; if (w) await signAs(app, deal.id, role, w); }

    const rec = await app.settlement.settle(deal.id);
    expect(rec.status).toBe('DONE');
    deal = await app.deals.get(deal.id);
    expect(deal.state).toBe('SETTLED');
    // A preimage R foi revelada pelo pagamento Lightning (não pela mesa).
    expect(await app.adapters.require('lightning').revealedPreimage(deal.id)).toBe(R);
    expect((await ln.getBalance()).outboundSat).toBe(1_000_000n - amountSat); // o nó entregou o BTC
    // USDT do Comprador liberado ao Vendedor (tesouraria) no settle.
    expect(app.local!.evm.balanceOf(seller.address, LOCAL_TOKENS.usdtEth)).toBeGreaterThan(0n);
  }, 60_000);
});
