/**
 * Web Push "é sua vez de assinar": contrato dos endpoints. Degradação graciosa (sem VAPID → push
 * desligado) e inscrição exige sessão de participante.
 */
import { describe, it, expect } from 'vitest';
import webpush from 'web-push';
import { makeApp } from './helpers.js';

describe('Push · chave VAPID e inscrição', () => {
  it('sem VAPID configurado → push desligado (publicKey vazio, enabled false)', async () => {
    const { app } = await makeApp();
    const r = await app.api.inject({ method: 'GET', url: '/v1/push/vapid' });
    expect(r.statusCode).toBe(200);
    const d = r.json<{ publicKey: string; enabled: boolean }>();
    expect(d.enabled).toBe(false);
    expect(d.publicKey).toBe('');
    await app.close();
  });

  it('com VAPID configurado → expõe a chave pública e enabled true', async () => {
    const keys = webpush.generateVAPIDKeys();
    const { app } = await makeApp({ env: { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:test@verum.test' } });
    const r = await app.api.inject({ method: 'GET', url: '/v1/push/vapid' });
    const d = r.json<{ publicKey: string; enabled: boolean }>();
    expect(d.enabled).toBe(true);
    expect(d.publicKey).toBe(keys.publicKey);
    await app.close();
  });

  it('inscrever sem sessão de participante → negado', async () => {
    const { app } = await makeApp();
    const r = await app.api.inject({ method: 'POST', url: '/v1/mesas/mesa_x/push/subscribe', payload: { subscription: { endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } } } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    await app.close();
  });
});
