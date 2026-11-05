/**
 * Deploy do escrow V2 **v3** (comissão na perna do Vendedor) na TRON SHASTA — VerumV2Lib + escrow.
 *
 * O fonte Tron (VerumOTCEscrowV2Tron) herda o MESMO VerumOTCEscrowV2Base/VerumV2Lib do EVM, então
 * o bytecode do forge já é v3 (TERMS_VERSION_V2 = 3). Deployer = ~/.verum-localnet/nile.env
 * (DEPLOYER_PK → TKpUibh1…, o owner TRON); owner/guardian = deployer; attestor = TRON_ATTESTOR_KEY
 * do .env; treasury = PLATFORM_TREASURY.tron.
 *
 * CUSTO MEDIDO (deploy 2026-11-05, Shasta): lib + escrow ≈ 255 TRX no total — bem abaixo do pior
 * caso teórico. Faucet: https://shasta.tronex.io (2.000 TRX/dia). Gate de saldo: 400 TRX.
 * ⚠️ O ABI do forge traz enums como "VerumOTCEscrowBase.Role" que o TronWeb rejeita — o
 * sanitizeAbi abaixo os troca por uint8 (enum = uint8 no ABI canônico).
 *
 * Depois do deploy: atualizar no .env → TRON_ESCROW_V2_ADDRESS=<novo> e TRON_TERMS_VERSION=3.
 *
 * Uso: npx tsx --env-file=.env scripts/deploy-escrow-v2-tron-shasta.mts [caminho-do-repo-onchain]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { keccak256, toHex } from 'viem';
import { TronWeb } from 'tronweb';
import { loadConfig, tronConfig, PLATFORM_TREASURY } from '../src/config.js';

const ONCHAIN = process.argv[2] ?? 'C:/Users/gabri/Downloads/verum-otc-onchain/verum-otc-onchain';
const OUT = `${ONCHAIN}/contracts/evm/out`;
const SHASTA_CHAIN_ID = 2494104990n;

const config = loadConfig(process.env);
const tron = tronConfig(config);
if (!tron) { console.error('grupo TRON_* ausente no .env'); process.exit(1); }

const localnet = Object.fromEntries(readFileSync(path.join(process.env.USERPROFILE as string, '.verum-localnet', 'nile.env'), 'utf8').trim().split(/\r?\n/).map(l => l.split('=')));
const tw = new TronWeb({ fullHost: tron.fullHost, privateKey: String(localnet.DEPLOYER_PK).replace(/^0x/, '') });
const deployer = tw.defaultAddress.base58 as string;
const attestorB58 = TronWeb.address.fromPrivateKey(tron.attestorKey.replace(/^0x/, '')) as string;
const treasury = PLATFORM_TREASURY.tron;
console.log(`deployer/owner ${deployer} · attestor ${attestorB58} · treasury ${treasury}`);

const bal = await tw.trx.getBalance(deployer);
console.log(`saldo ${bal / 1e6} TRX`);
if (bal < 400_000_000) { console.error('precisa de ≥400 TRX na Shasta (faucet: https://shasta.tronex.io) — deploy medido em ~255 TRX'); process.exit(1); }

/** Enums do forge ("VerumOTCEscrowBase.Role") → uint8 (o TronWeb rejeita tipos com ponto). */
const sanitizeAbi = (abi: unknown[]): unknown[] => JSON.parse(JSON.stringify(abi), (k, v) => k === 'type' && typeof v === 'string' && v.includes('.') ? 'uint8' : v) as unknown[];
const artifact = (rel: string): { abi: unknown[]; bytecode: string } => {
  const j = JSON.parse(readFileSync(`${OUT}/${rel}`, 'utf8')) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: sanitizeAbi(j.abi), bytecode: j.bytecode.object.replace(/^0x/, '') };
};

const deploy = async (label: string, abi: unknown[], bytecode: string, parameters: unknown[]): Promise<string> => {
  console.log(`deployando ${label}…`);
  const c = await tw.contract().new({ abi: abi as never, bytecode, feeLimit: 5_000_000_000, callValue: 0, userFeePercentage: 100, parameters: parameters as never });
  const addr = tw.address.fromHex(String((c as unknown as { address: string }).address));
  console.log(`  ${label} → ${addr}`);
  return addr;
};

// 1) VerumV2Lib
const lib = artifact('VerumV2Lib.sol/VerumV2Lib.json');
const libAddr = await deploy('VerumV2Lib', lib.abi, lib.bytecode, []);
const libHex20 = TronWeb.address.toHex(libAddr).slice(2); // 41‖hex20 → hex20 (link TVM usa os 20 bytes)

// 2) Escrow linkado
const esc = artifact('VerumOTCEscrowV2Tron.sol/VerumOTCEscrowV2Tron.json');
const placeholderHash = keccak256(toHex('src/VerumV2Lib.sol:VerumV2Lib')).slice(2, 36);
const linked = esc.bytecode.replaceAll(`__$${placeholderHash}$__`, libHex20.toLowerCase());
if (linked.includes('__$')) throw new Error('bytecode ainda tem placeholder de link não resolvido');

// 3) Deploy (tronChainId, owner, guardian, attestor, treasury)
const escAddr = await deploy('VerumOTCEscrowV2Tron', esc.abi, linked, [SHASTA_CHAIN_ID, deployer, deployer, attestorB58, treasury]);

// 4) addToken tUSDT/tBTC (TRX nativo = sentinela, dispensa registry)
const ESCROW_ABI = [
  { type: 'function', name: 'addToken', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'decimals_', type: 'uint8' }, { name: 'symbol_', type: 'string' }], outputs: [] },
  { type: 'function', name: 'TERMS_VERSION_V2', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
] as const;
const escrow = await tw.contract(ESCROW_ABI as never, escAddr);
for (const [token, decimals, symbol] of [[tron.tusdt, 6, 'tUSDT'], [tron.tbtc, 8, 'tBTC']] as const) {
  console.log(`addToken ${symbol}…`);
  await (escrow as never as Record<string, (...a: unknown[]) => { send: (o: object) => Promise<unknown> }>).addToken!(token, decimals, symbol).send({ feeLimit: 200_000_000 });
}
const version = await (escrow as never as Record<string, () => { call: () => Promise<unknown> }>).TERMS_VERSION_V2!().call();

console.log('\n===== deploy Shasta concluído =====');
console.log(`VerumV2Lib:        ${libAddr}`);
console.log(`Escrow V2 Tron:    ${escAddr}`);
console.log(`TERMS_VERSION_V2:  ${String(version)} (esperado 3)`);
console.log(`\nAtualize no .env (local e Vercel):`);
console.log(`TRON_ESCROW_V2_ADDRESS=${escAddr}`);
console.log(`TRON_TERMS_VERSION=3`);
