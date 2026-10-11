/**
 * Adaptador serverless do VERUM OTC para o Vercel (§deploy).
 * Envolve a instância Fastify (createApp) e responde emitindo o evento 'request' — padrão
 * serverless do Fastify (nunca chama listen). A app é construída uma vez por instância (cache
 * entre invocações quentes).
 *
 * LIMITAÇÕES CONHECIDAS no runtime serverless do Vercel (aceitas nesta fase):
 *  - WebSocket (/v1/ws, /v1/rooms/:id/stream) NÃO funciona — o runtime não mantém conexões.
 *  - Estado em memória/arquivo (identidade, salas, propostas, OTP, sessões do portal) é efêmero e
 *    por-instância → migrar para Redis/Postgres externos antes de uso real. Aqui roda em memória.
 *  - O scheduler de expiração não é iniciado (só faz sentido num servidor persistente).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { createApp } from '../dist/app.js';

// web/*.html vão no bundle via functions.includeFiles; resolvemos por caminho absoluto.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PORTAL_HTML_PATH ||= path.join(root, 'web/verum-saas.html');
process.env.MESA_HTML_PATH ||= path.join(root, 'web/verum-dashboard.html');
process.env.CONVITE_HTML_PATH ||= path.join(root, 'web/verum-convite.html');
// No Vercel só /tmp é gravável; o PortalService grava aqui (efêmero, por-instância).
process.env.PORTAL_DATA_FILE ||= '/tmp/verum-portal.json';

let appPromise;
function boot() { if (!appPromise) appPromise = createApp(loadConfig()); return appPromise; }

export default async function handler(req, res) {
  try {
    const app = await boot();
    await app.api.ready();
    app.api.server.emit('request', req, res);
  } catch (err) {
    // Diagnóstico: superfície o erro de inicialização (em vez de uma página genérica do Vercel).
    // Permite novo boot na próxima requisição caso a causa seja transitória/corrigida por env.
    appPromise = undefined;
    const e = /** @type {Error} */ (err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'BOOT_FAILED', message: String((e && e.message) || e), reqUrl: req.url, stack: String((e && e.stack) || '').split('\n').slice(0, 8) }));
  }
}
