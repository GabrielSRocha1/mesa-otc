/**
 * PWA do VERUM OTC — manifest, service worker, ícones e página offline, servidos same-origin
 * (compatível com o CSP estrito). Projeto CONSCIENTE DE SEGURANÇA (§7/§8):
 * - O service worker NUNCA cacheia respostas de API (`/v1`, `/ops`, `/metrics`) nem requisições
 *   com Authorization, nem o HTML autenticado das navegações — só um shell estático mínimo.
 * - Navegações são network-first com fallback para /offline.html (nada sensível é persistido).
 */

const THEME = '#0b1220';
const ACCENT = '#4f9bff';
const ACCENT2 = '#22c55e';

/** Ícone principal (any). SVG same-origin — sem binário, passa no CSP img-src 'self'. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="VERUM OTC">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="${ACCENT2}"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="${THEME}"/>
<path d="M140 150 L256 372 L372 150" fill="none" stroke="url(#g)" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="256" cy="150" r="26" fill="${ACCENT2}"/>
</svg>`;

/** Ícone maskable (zona de segurança ~20% de margem). */
export const ICON_MASKABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="VERUM OTC">
<defs><linearGradient id="gm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="${ACCENT2}"/></linearGradient></defs>
<rect width="512" height="512" fill="${THEME}"/>
<path d="M176 190 L256 340 L336 190" fill="none" stroke="url(#gm)" stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="256" cy="190" r="20" fill="${ACCENT2}"/>
</svg>`;

/** Web App Manifest (application/manifest+json). */
export const MANIFEST_JSON = JSON.stringify({
  id: '/portal',
  name: 'VERUM OTC — Mesa de Operação',
  short_name: 'VERUM OTC',
  description: 'Mesa de operação OTC/P2P institucional, multichain e não custodial.',
  lang: 'pt-BR',
  start_url: '/portal',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'any',
  background_color: THEME,
  theme_color: THEME,
  categories: ['finance', 'business'],
  icons: [
    { src: '/icons/verum.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icons/verum-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
});

/** Service worker — shell estático + offline; jamais cacheia API/HTML autenticado. */
export const SW_JS = `/* VERUM OTC service worker */
const CACHE = 'verum-otc-shell-v3'; // v3: auto-update (updateViaCache none + reload no controllerchange) — evita página presa em versão antiga no dapp-browser
const SHELL = ['/offline.html', '/icons/verum.svg', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // nunca intercepta mutações
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // só same-origin
  // NUNCA cacheia API/métricas/dados sensíveis nem requisições autenticadas.
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/ops/') || url.pathname === '/metrics' || req.headers.has('authorization')) return;
  if (req.mode === 'navigate') {                       // HTML autenticado: network-first, sem cachear.
    // NUNCA resolver com undefined (o browser converte em network-error e DERRUBA a página):
    // sem rede e sem offline.html no cache, devolve 503 explícito.
    e.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || new Response('Sem conexao. Tente novamente.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })));
    return;
  }
  // Assets estáticos same-origin: stale-while-revalidate. Cache.put exige 200 COMPLETO —
  // res.ok inclui 206 (resposta parcial de range request) e lançava TypeError no put.
  e.respondWith(caches.match(req).then(cached => {
    const net = fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') { const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {}); }
      return res;
    }).catch(() => cached || new Response('', { status: 504 }));
    return cached || net;
  }));
});
`;

/** Página offline (estática, sem qualquer dado sensível). */
export const OFFLINE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>VERUM OTC — offline</title>
<meta name="theme-color" content="${THEME}">
<style>html,body{margin:0;height:100%}body{background:${THEME};color:#e6edf7;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;text-align:center;padding:24px}
.c{max-width:360px}.i{width:72px;height:72px;margin:0 auto 18px}h1{font-size:19px;margin:0 0 8px}p{color:#9fb0c9;margin:0 0 18px}
button{background:${ACCENT};color:#fff;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:600;cursor:pointer}</style></head>
<body><div class="c"><div class="i">${ICON_SVG}</div><h1>Você está offline</h1>
<p>O VERUM OTC precisa de conexão para operar com segurança. Reconecte para continuar.</p>
<button onclick="location.reload()">Tentar novamente</button></div></body></html>`;

/** Tags PWA injetadas no <head> das páginas servidas. */
const PWA_HEAD_TAGS = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  `<meta name="theme-color" content="${THEME}">`,
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="VERUM OTC">',
  '<link rel="icon" type="image/svg+xml" href="/icons/verum.svg">',
  '<link rel="apple-touch-icon" href="/icons/verum.svg">',
].join('');

/** Registro do service worker (inline; permitido pelo CSP script-src 'unsafe-inline').
 *  AUTO-UPDATE: `updateViaCache:'none'` (busca sw.js sempre fresco) + `reg.update()` no load +
 *  reload ÚNICO quando um SW novo assume o controle — assim um deploy novo não fica preso atrás de
 *  um HTML velho no webview do dapp-browser. Não recarrega na primeira instalação (sem controller). */
const PWA_SW_REG = `<script>if('serviceWorker'in navigator){(function(){var had=!!navigator.serviceWorker.controller,ref=false;navigator.serviceWorker.addEventListener('controllerchange',function(){if(ref||!had)return;ref=true;location.reload();});window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(function(r){try{r.update();}catch(e){}}).catch(function(){});});})();}</script>`;

/** Injeta manifest/ícones no <head> e o registro do SW antes de </body>. */
export function injectPwa(html: string): string {
  let out = html.includes('</head>') ? html.replace('</head>', PWA_HEAD_TAGS + '</head>') : PWA_HEAD_TAGS + html;
  out = out.includes('</body>') ? out.replace('</body>', PWA_SW_REG + '</body>') : out + PWA_SW_REG;
  return out;
}
