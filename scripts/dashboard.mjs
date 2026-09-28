/** Sobe a API já servindo o dashboard institucional (web/verum-dashboard.html) em http://127.0.0.1:8080/app */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const env = {
  ...process.env,
  OTC_ENV: process.env.OTC_ENV ?? 'dev',
  HOST: process.env.HOST ?? '127.0.0.1',
  PORT: process.env.PORT ?? '8080',
  UI_HTML_PATH: process.env.UI_HTML_PATH ?? './web/verum-saas.html',
  MESA_HTML_PATH: process.env.MESA_HTML_PATH ?? './web/verum-dashboard.html',
};

const child = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
