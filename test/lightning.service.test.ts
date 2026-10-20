/**
 * Fase 1 — o LndRestService (cliente REST REAL) contra o LndFake in-process, e o LightningSimulator.
 * Prova o acoplamento por preimage: payInvoice só revela a preimage se sha256(preimage)==payment_hash
 * (a MESMA checagem do settleV2). Cobre liquidez insuficiente e preimage ausente (comprador não revela).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { LndRestService } from '../src/adapters/lightning/lndRest.js';
import { LightningSimulator } from '../src/adapters/lightning/simulator.js';
import { LndFake } from './lndFake.js';
import type { LndSettings } from '../src/config.js';

const preimageHex = () => bytesToHex(randomBytes(32));
const hashOf = (pre: string) => bytesToHex(sha256(hexToBytes(pre)));

describe('Lightning — LndRestService contra o LndFake (REST real)', () => {
  const fake = new LndFake();
  afterAll(async () => { await fake.stop(); });

  it('invoice → pagamento revela a preimage (sha256==payment_hash); liquidez e no-preimage falham', async () => {
    const url = await fake.start();
    const cfg: LndSettings = { restUrl: url, macaroonHex: 'ab'.repeat(16), tlsCert: '', invoiceExpirySec: 600, paymentTimeoutSec: 30 };
    const ln = new LndRestService(cfg);

    expect((await ln.getNodeInfo()).chains).toContain('bitcoin');
    expect((await ln.getBalance()).outboundSat).toBe(100_000_000n);

    // Caminho feliz: o Comprador gera R, o fake conhece R (semeado), a invoice carrega H.
    const R = preimageHex(); const H = fake.seedPreimage(R);
    const inv = await ln.addInvoice(H, 20_000n, 'swap-test');
    expect(inv.paymentHash).toBe(H);
    const dec = await ln.decodeInvoice(inv.bolt11);
    expect(dec.paymentHash).toBe(H);
    expect(dec.amountSat).toBe(20_000n);

    const pay = await ln.payInvoice(inv.bolt11, { timeoutSec: 5 });
    expect(pay.status).toBe('succeeded');
    expect(pay.preimage).toBe(R);                       // a preimage revelada destrava o settleV2
    expect(hashOf(pay.preimage as string)).toBe(H);     // sha256(preimage)==H (idêntico ao contrato)
    expect((await ln.getBalance()).outboundSat).toBe(100_000_000n - 20_000n); // liquidez caiu pelo valor

    // Comprador NUNCA revela (invoice sem preimage semeada) → pagamento falha; nada é entregue.
    const H2 = hashOf(preimageHex());
    const inv2 = await ln.addInvoice(H2, 20_000n, 'nunca-revela');
    const pay2 = await ln.payInvoice(inv2.bolt11, { timeoutSec: 5 });
    expect(pay2.status).toBe('failed');
    expect(pay2.preimage).toBeNull();

    // Liquidez insuficiente → falha com motivo claro (precheck deve barrar antes).
    const R3 = preimageHex(); const H3 = fake.seedPreimage(R3);
    const inv3 = await ln.addInvoice(H3, 999_000_000n, 'grande');
    const pay3 = await ln.payInvoice(inv3.bolt11, { timeoutSec: 5 });
    expect(pay3.status).toBe('failed');
    expect(pay3.failureReason).toMatch(/INSUFFICIENT/);
  }, 30_000);
});

describe('Lightning — LightningSimulator (in-process)', () => {
  it('casa sha256(preimage)==paymentHash e revela a preimage; respeita a liquidez', async () => {
    const sim = new LightningSimulator(50_000n);
    const R = preimageHex(); const H = sim.seedPreimage(R);
    const inv = await sim.addInvoice(H, 20_000n, 'sim');
    const pay = await sim.payInvoice(inv.bolt11);
    expect(pay.status).toBe('succeeded');
    expect(pay.preimage).toBe(R);
    expect((await sim.getBalance()).outboundSat).toBe(30_000n);

    // Segundo swap maior que a liquidez restante → falha.
    const R2 = preimageHex(); const H2 = sim.seedPreimage(R2);
    const inv2 = await sim.addInvoice(H2, 40_000n, 'sim2');
    const pay2 = await sim.payInvoice(inv2.bolt11);
    expect(pay2.status).toBe('failed');
    expect(pay2.failureReason).toBe('insufficient_liquidity');
  });
});
