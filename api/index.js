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
process.env.OPERACAO_HTML_PATH ||= path.join(root, 'web/verum-operacao.html'); // /op/:dealId e /ver/:mesaId (visualização pública)
// No Vercel só /tmp é gravável; o PortalService grava aqui (efêmero, por-instância).
process.env.PORTAL_DATA_FILE ||= '/tmp/verum-portal.json';

let appPromise;
let lastRecoverAt = 0;
function boot() {
  if (!appPromise) {
    appPromise = createApp(loadConfig()).then(app => {
      // Recuperação de liquidações (igual ao boot do servidor persistente): deals presas em
      // SETTLING/SETTLEMENT_VALIDATION reconciliam com o estado on-chain — sem isto, uma
      // instância que morreu no meio do settle deixava a operação "Liquidando" para sempre.
      void app.settlement.recover().then(r => { if (r.length) console.log('recuperação de liquidações:', JSON.stringify(r)); }).catch(() => {});
      lastRecoverAt = Date.now();
      return app;
    });
  }
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await boot();
    // Re-dispara a recuperação periodicamente em instância quente (debounce 60s): o tráfego do
    // próprio portal (polling das telas) vira o "cron" do keeper em serverless.
    if (Date.now() - lastRecoverAt > 60_000) { lastRecoverAt = Date.now(); void app.settlement.recover().catch(() => {}); }
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
