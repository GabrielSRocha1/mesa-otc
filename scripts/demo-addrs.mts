// Imprime os endereços Solana do keyring demo (credenciais default) p/ financiar no localnet.
import { DemoMesaKeyring, demoSecret, DEMO_ROLES } from '../src/portal/demo.js';
const kr = new DemoMesaKeyring(demoSecret('demo@verumotc.com', 'VerumDemo2026'));
for (const r of DEMO_ROLES) console.log(r, kr.addressFor(r));
