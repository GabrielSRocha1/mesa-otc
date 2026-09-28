/** Ponto de entrada. `OTC_ENV=dev` usa simuladores locais; produção exige adaptadores reais, Postgres e segredos por ambiente. */
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { logger } from './monitoring/metrics.js';

const config = loadConfig();
const app = await createApp(config);
app.startScheduler();
const recovered = await app.settlement.recover(); if (recovered.length) logger.info({ recovered }, 'recuperação de liquidações');
await app.api.listen({ port: config.PORT, host: config.HOST });
logger.info({ port: config.PORT, env: config.OTC_ENV, db: config.DATABASE_MODE }, 'VERUM OTC API no ar');
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
