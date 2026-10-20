/**
 * Fase 4 (wiring) — o App expõe o LightningService; default = simulador (LND_SIMULATE/ausente);
 * injeção via AppOverrides.lightning funciona. Garante que o Lightning fica disponível e INERTE
 * (não liga em nenhum fluxo existente — o HTLC on-chain segue intacto).
 */
import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers.js';
import { LightningSimulator } from '../src/adapters/lightning/simulator.js';

describe('Lightning — wiring no App', () => {
  it('expõe o serviço (simulador por default) e aceita injeção; app segue funcional', async () => {
    const { app } = await makeApp({});
    expect(app.lightning).toBeDefined();
    expect(app.lightningReal).toBe(false);                 // sem grupo LND_* → simulador
    expect((await app.lightning.getNodeInfo()).chains).toContain('bitcoin');
    await app.close();
  });

  it('AppOverrides.lightning injeta um nó mockado', async () => {
    const sim = new LightningSimulator(42n);
    const { app } = await makeApp({ lightning: sim });
    expect(app.lightning).toBe(sim);
    expect((await app.lightning.getBalance()).outboundSat).toBe(42n);
    await app.close();
  });
});
