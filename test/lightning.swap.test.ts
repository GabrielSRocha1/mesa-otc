/**
 * Fase 3 — a mecânica ATÔMICA do LightningSwapCoordinator. Um escrow-adapter em memória (que
 * valida sha256(preimage)==htlcHash no settle, como o escrow V2) + o LightningSimulator provam:
 *  a) swap completo: USDT travado → paga invoice → R revelado → settle; nunca o inverso.
 *  b) comprador não revela → payment_failed → depois expira → refund do USDT ao comprador.
 *  c) USDT não travado → NÃO paga (awaiting_funding) — o nó nunca entrega BTC antes.
 *  d) dupla liquidação → idempotente (already_settled).
 *  e) liquidez insuficiente → precheck barra; se tentar, payment falha.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { LightningSwapCoordinator } from '../src/engines/lightningSwap.js';
import { LightningSimulator } from '../src/adapters/lightning/simulator.js';
import type { OnChainDealState, SettlementAdapter, TxRef } from '../src/adapters/types.js';

const pre = () => bytesToHex(randomBytes(32));
const hashOf = (p: string) => bytesToHex(sha256(hexToBytes(p)));

/** Escrow mínimo em memória: honra o hashlock (settle exige sha256(preimage)==htlcHash) e a janela. */
function fakeEscrow(htlcHash: string, opts: { funded?: boolean; expiresAt?: number; now?: () => number } = {}) {
  let status: OnChainDealState['status'] = opts.funded ? 'FUNDED' : 'REGISTERED';
  let settledTx: string | undefined; let settles = 0; let refunds = 0;
  const now = opts.now ?? (() => Date.now());
  const expiresAt = opts.expiresAt ?? now() + 40 * 60_000;
  const adapter = {
    async getDealState(): Promise<OnChainDealState> { return { status, revision: 1, deposits: {}, settledLegs: {}, settledTx, dealHash: '', expiresAt }; },
    async settle(_d: string, _i: number, _s: unknown[], preimage?: string): Promise<TxRef> {
      if (status === 'SETTLED') throw new Error('já liquidado');
      if (status !== 'FUNDED') throw new Error('não financiado');
      if (!preimage || hashOf(preimage) !== htlcHash) throw new Error('preimage inválida'); // = escrow V2
      status = 'SETTLED'; settledTx = 'settle-' + (++settles); return { chain: 'ethereum', ref: settledTx, submittedAt: now() };
    },
    async refund(): Promise<TxRef> {
      if (now() < expiresAt) throw new Error('refund só após a janela'); // = contrato
      status = 'REFUNDED'; return { chain: 'ethereum', ref: 'refund-' + (++refunds), submittedAt: now() };
    },
    setFunded() { status = 'FUNDED'; },
    counters() { return { settles, refunds, status }; },
  };
  return adapter as unknown as SettlementAdapter & { setFunded(): void; counters(): { settles: number; refunds: number; status: string } };
}

describe('LightningSwapCoordinator — atomicidade Lightning ⇄ escrow', () => {
  it('a) swap completo: USDT travado → paga → R revelado → settle', async () => {
    const R = pre(); const H = hashOf(R);
    const ln = new LightningSimulator(1_000_000n); ln.seedPreimage(R);
    const inv = await ln.addInvoice(H, 20_000n, 'swap');
    const escrow = fakeEscrow(H, { funded: true });
    const co = new LightningSwapCoordinator(escrow, ln, 1);
    const out = await co.payAndSettle('deal-a', inv.bolt11, H);
    expect(out.status).toBe('settled');
    expect(out.status === 'settled' && out.preimage).toBe(R);
    expect(escrow.counters().status).toBe('SETTLED');
    expect((await ln.getBalance()).outboundSat).toBe(980_000n); // o nó entregou 20k sats
  });

  it('b) comprador nunca revela → payment_failed; expira → refund do USDT', async () => {
    const H = hashOf(pre());                                   // ninguém semeia R → nunca liquida
    const t0 = Date.now(); const clock = { t: t0 }; const now = () => clock.t;
    const ln = new LightningSimulator(1_000_000n, now);
    const inv = await ln.addInvoice(H, 20_000n, 'nunca');
    const escrow = fakeEscrow(H, { funded: true, expiresAt: t0 + 40 * 60_000, now });
    const co = new LightningSwapCoordinator(escrow, ln, 1, now);
    const out = await co.payAndSettle('deal-b', inv.bolt11, H);
    expect(out.status).toBe('payment_failed');
    expect(escrow.counters().status).toBe('FUNDED');           // USDT segue travado, intacto
    // antes da janela: refund recusado (fica pendente)
    expect((await co.refundIfUnpaid('deal-b')).status).toBe('pending');
    clock.t = t0 + 41 * 60_000;                                // janela vence
    expect((await co.refundIfUnpaid('deal-b')).status).toBe('refunded');
    expect(escrow.counters().status).toBe('REFUNDED');
  });

  it('c) USDT NÃO travado → o nó nunca paga (awaiting_funding)', async () => {
    const R = pre(); const H = hashOf(R);
    const ln = new LightningSimulator(1_000_000n); ln.seedPreimage(R);
    const inv = await ln.addInvoice(H, 20_000n, 'sem-lock');
    const escrow = fakeEscrow(H, { funded: false });           // REGISTERED, não FUNDED
    const co = new LightningSwapCoordinator(escrow, ln, 1);
    const out = await co.payAndSettle('deal-c', inv.bolt11, H);
    expect(out.status).toBe('awaiting_funding');
    expect((await ln.getBalance()).outboundSat).toBe(1_000_000n); // nada entregue
  });

  it('d) dupla liquidação → idempotente', async () => {
    const R = pre(); const H = hashOf(R);
    const ln = new LightningSimulator(1_000_000n); ln.seedPreimage(R);
    const inv = await ln.addInvoice(H, 20_000n, 'dup');
    const escrow = fakeEscrow(H, { funded: true });
    const co = new LightningSwapCoordinator(escrow, ln, 1);
    const a = await co.payAndSettle('deal-d', inv.bolt11, H);
    expect(a.status).toBe('settled');
    const b = await co.payAndSettle('deal-d', inv.bolt11, H);  // 2ª vez
    expect(b.status).toBe('already_settled');
    expect(escrow.counters().settles).toBe(1);                 // settle rodou UMA vez só
  });

  it('e) liquidez insuficiente → precheck barra; pagamento falha se tentado', async () => {
    const R = pre(); const H = hashOf(R);
    const ln = new LightningSimulator(10_000n); ln.seedPreimage(R); // só 10k outbound
    const inv = await ln.addInvoice(H, 20_000n, 'grande');
    const escrow = fakeEscrow(H, { funded: true });
    const co = new LightningSwapCoordinator(escrow, ln, 1);
    expect((await co.hasLiquidity(20_000n)).ok).toBe(false);   // precheck da aprovação barraria
    const out = await co.payAndSettle('deal-e', inv.bolt11, H);
    expect(out.status).toBe('payment_failed');
    expect(escrow.counters().status).toBe('FUNDED');           // USDT intacto
  });
});
