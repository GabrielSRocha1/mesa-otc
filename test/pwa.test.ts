/**
 * PWA do VERUM OTC (§7). Prova instalabilidade (manifest + ícones + SW registrado nas páginas)
 * e o desenho CONSCIENTE DE SEGURANÇA do service worker (nunca cacheia API/HTML autenticado).
 */
import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers.js';

const withHtml = () => makeApp({ env: { MESA_HTML_PATH: './web/verum-dashboard.html', PORTAL_HTML_PATH: './web/verum-saas.html', CONVITE_HTML_PATH: './web/verum-convite.html' } });

describe('§7 PWA — instalabilidade', () => {
  it('manifest válido, ícones SVG, offline e SW são servidos same-origin', async () => {
    const { app } = await withHtml();
    const man = await app.api.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(man.statusCode).toBe(200);
    expect(man.headers['content-type']).toContain('application/manifest+json');
    const m = man.json<{ name: string; start_url: string; display: string; scope: string; icons: { src: string; purpose: string }[] }>();
    expect(m.display).toBe('standalone'); expect(m.start_url).toBe('/portal'); expect(m.scope).toBe('/');
    expect(m.icons.some(i => i.purpose === 'maskable')).toBe(true);
    expect(m.icons.some(i => i.purpose === 'any')).toBe(true);

    const icon = await app.api.inject({ method: 'GET', url: '/icons/verum.svg' });
    expect(icon.statusCode).toBe(200); expect(icon.headers['content-type']).toContain('image/svg+xml');
    expect((await app.api.inject({ method: 'GET', url: '/icons/verum-maskable.svg' })).statusCode).toBe(200);

    const off = await app.api.inject({ method: 'GET', url: '/offline.html' });
    expect(off.statusCode).toBe(200); expect(off.body.toLowerCase()).toContain('offline');
    await app.close();
  });

  it('as páginas servidas incluem o manifest e registram o service worker', async () => {
    const { app } = await withHtml();
    for (const url of ['/portal', '/mesa', '/convite']) {
      const r = await app.api.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toContain('<link rel="manifest" href="/manifest.webmanifest">');
      expect(r.body, url).toContain("serviceWorker.register('/sw.js')");
      expect(r.body, url).toContain('name="theme-color"');
    }
    await app.close();
  });
});

describe('§7/§8 PWA — service worker não vaza dados sensíveis', () => {
  it('o SW é servido como JS e, por desenho, não cacheia API nem requisições autenticadas', async () => {
    const { app } = await withHtml();
    const sw = await app.api.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['content-type']).toContain('text/javascript');
    expect(sw.headers['cache-control']).toContain('no-cache');
    // Guardas de segurança presentes no código do worker.
    expect(sw.body).toContain("startsWith('/v1/')");
    expect(sw.body).toContain("startsWith('/ops/')");
    expect(sw.body).toContain("req.headers.has('authorization')");
    // Navegação é network-first com fallback offline (não persiste HTML autenticado).
    expect(sw.body).toContain("caches.match('/offline.html')");
    await app.close();
  });
});
