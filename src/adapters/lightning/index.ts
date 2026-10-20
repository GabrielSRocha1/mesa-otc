/**
 * Lightning — ponto de entrada. `createLightningService` escolhe o nó REST real (grupo LND_* completo)
 * ou o simulador in-process (LND_SIMULATE=1 ou grupo ausente), espelhando o padrão bitcoinConfig.
 */
import { lndConfig, type Config } from '../../config.js';
import { LndRestService } from './lndRest.js';
import { LightningSimulator } from './simulator.js';
import type { LightningService } from './types.js';

export type { LightningService, LnInvoice, LnPayment, LnNodeInfo, LnBalance } from './types.js';
export { LndRestService } from './lndRest.js';
export { LightningSimulator } from './simulator.js';

/** Serviço LN real quando o grupo LND_* está completo; senão o simulador (preview/dev/teste). */
export function createLightningService(config: Config): { service: LightningService; real: boolean } {
  const cfg = lndConfig(config);
  if (cfg) return { service: new LndRestService(cfg), real: true };
  return { service: new LightningSimulator(), real: false };
}
