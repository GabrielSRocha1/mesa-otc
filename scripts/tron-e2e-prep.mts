// Prepara o e2e Tron: deriva as carteiras de papel (TronDevKeyring, master do e2e),
// financia TRX a partir do deployer e minta os TRC-20 mocks p/ seller e buyer.
import { TronDevKeyring } from '../src/adapters/verum/keyring.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TronWeb } from 'tronweb';

const MASTER = 'e2e'.repeat(22).slice(0, 64);
const kr = new TronDevKeyring(MASTER);
const owners = { SELLER: 'e2e-seller', BUYER: 'e2e-buyer', PAYMASTER_1: 'e2e-pm1', PAYMASTER_2: 'e2e-pm2' } as const;
const env = Object.fromEntries(readFileSync(path.join(process.env.USERPROFILE as string, '.verum-localnet', 'nile.env'), 'utf8').trim().split(/\r?\n/).map(l => l.split('=')));
const HOST = process.env.TRON_FULL_HOST ?? 'https://api.shasta.trongrid.io';
const tw = new TronWeb({ fullHost: HOST, privateKey: (env.DEPLOYER_PK as string).replace(/^0x/, '') });
const TUSDT = 'TMc2iDSmxK7QzoSzQ3R6qWrfaBhS884tuD';
const TBTC = 'TKMB9pNaKoNfGpeD4acUomNymGH8Q6CrQ2';
const EXECUTOR = 'TMJYnZv278j382S92zXSypdXBkPnupDWUv';

const mockAbi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const main = async () => {
  const addr: Record<string, string> = {};
  for (const [role, owner] of Object.entries(owners)) { addr[role] = kr.addressFor(owner); console.log(role + '=' + addr[role]); }
  // TRX p/ taxas (deployer → papéis + executor)
  for (const [to, trx] of [[addr.PAYMASTER_1, 250], [addr.SELLER, 120], [addr.BUYER, 120], [addr.PAYMASTER_2, 30], [EXECUTOR, 200]] as const) {
    const r = await tw.trx.sendTransaction(to, trx * 1e6);
    if (!r.result) throw new Error('transfer falhou p/ ' + to);
  }
  console.log('TRX distribuído');
  // tokens p/ os depositantes
  const usdt = await tw.contract(mockAbi, TUSDT);
  const btc = await tw.contract(mockAbi, TBTC);
  await usdt.mint(addr.SELLER, '200000000000').send({ feeLimit: 100_000_000 }); // 200.000 tUSDT
  await btc.mint(addr.BUYER, '500000000').send({ feeLimit: 100_000_000 });      // 5 tBTC
  await new Promise(r => setTimeout(r, 6000));
  console.log('seller tUSDT:', (await usdt.balanceOf(addr.SELLER).call()).toString());
  console.log('buyer tBTC:', (await btc.balanceOf(addr.BUYER).call()).toString());
};
main().catch(e => { console.error(e.message ?? e); process.exit(1); });
