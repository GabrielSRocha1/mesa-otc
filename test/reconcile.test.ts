/**
 * Reconciliação on-chain (auditoria 2026-10-20) — o estado real do swap é o do CONTRATO, não o do
 * portal. Replica de forma determinística (adapters locais in-process) o incidente que forçou o
 * resgate manual de WETH com o keeper:
 *   DESCASAMENTO → REEMBOLSO AUTOMÁTICO: uma leg é paga on-chain (signV2) mas o portal nunca marca o
 *   funding FINAL (aba fechada / turno expirado antes da re-checagem do /approvals). A operação
 *   expira. Sem a reconciliação, o reembolso automático NÃO cobre a leg paga e os fundos ficam
 *   presos. Com a reconciliação, o motor lê getDealState, marca FINAL e reembolsa sozinho.
 */
import { describe, it, expect } from 'vitest';
import { makeApp, prepareDeal, solWallet, type Parts } from './helpers.js';

describe('Reconciliação on-chain — fundos presos por descasamento portal↔contrato', () => {
  it('leg paga on-chain mas funding não-FINAL no portal → expira → reconcilia e reembolsa sozinho', async () => {
    const { app, clock } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts, { expiresInSec: 900 });
    await app.deals.open(d.id, parts.SELLER.address);                  // registra on-chain → AWAITING_SIGNATURES
    const t = (await app.deals.get(d.id)).terms!;
    const buyerLeg = t.legs.find(l => l.from === 'BUYER')!;

    // INJETA O DESCASAMENTO: o BUYER depositou NO CONTRATO (como o signV2 faz), mas o portal nunca
    // marcou FINAL — exatamente o estado que prendeu o WETH. Vai DIRETO no adapter, sem deals.fund.
    await app.local!.solana.deposit(d.id, buyerLeg.index, parts.BUYER.address);
    expect((await app.deals.get(d.id)).participants.find(p => p.role === 'BUYER')!.funding).not.toBe('FINAL');

    clock.advance(901_000);                                            // estoura o prazo da operação
    await app.deals.expireDue();

    const after = await app.deals.get(d.id);
    expect(after.state).toBe('REFUNDED');                              // antes do fix: ficava EXPIRED, fundos presos
    expect(after.refunds.find(r => r.role === 'BUYER')?.status).toBe('REFUNDED');
  });

  it('nenhuma leg paga on-chain → expira seco, sem REFUNDING nem reembolso espúrio', async () => {
    const { app, clock } = await makeApp({ autoSettle: false });
    const parts: Parts = { SELLER: solWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts, { expiresInSec: 900 });
    await app.deals.open(d.id, parts.SELLER.address);
    clock.advance(901_000);
    await app.deals.expireDue();
    const after = await app.deals.get(d.id);
    expect(after.state).toBe('EXPIRED');                               // sem depósito on-chain, nada a reembolsar
    expect(after.refunds).toHaveLength(0);
  });
});
