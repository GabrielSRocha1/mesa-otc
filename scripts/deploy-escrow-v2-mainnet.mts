/**
 * Deploy do escrow V2 (perna nativa ETH) na ETHEREUM MAINNET — VerumV2Lib + escrow linkado.
 *
 * Diferenças da variante Sepolia (deploy-escrow-v2-native.mts):
 *  - EIP-7825 ATIVO na mainnet: teto de 16.777.216 gás/tx — gás explícito lib ~4M, escrow ~10,5M
 *    (medidos: lib ~2,38M, escrow ~6,81M; folga p/ repricing).
 *  - Tokens reais no addToken: USDT/USDC/WBTC/WETH mainnet (constantes de src/config.ts).
 *  - Dois gates explícitos: MAINNET_AUTHORIZED=true E CONFIRM_MAINNET=yes (custa ETH real).
 *  - Owner/guardian/treasury: por padrão o DEPLOYER (decisão 2026-10-27 — Safe multisig depois,
 *    via scripts/escrow-v2-owner-ops.mts --transfer-to). Sobrescreva com OWNER_ADDRESS/
 *    GUARDIAN_ADDRESS/TREASURY_ADDRESS_MAINNET se já tiver o Safe.
 *
 * Pré-requisito: `forge build` em verum-otc-onchain/contracts/evm (NÃO mudar optimizer_runs=44).
 *
 * Uso:
 *   MAINNET_AUTHORIZED=true CONFIRM_MAINNET=yes \
 *   MAINNET_RPC_URL=https://mainnet.infura.io/v3/<key> \
 *   MAINNET_DEPLOYER_KEY=0x<chave-com-ETH> \
 *   MAINNET_ATTESTOR_ADDRESS=0x<endereco-do-attestor> \
 *   npx tsx scripts/deploy-escrow-v2-mainnet.mts [caminho-do-repo-onchain]
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, encodeDeployData, keccak256, toHex, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { ETH_MAINNET_TOKENS } from '../src/config.js';

const ONCHAIN = process.argv[2] ?? 'C:/Users/gabri/Downloads/verum-otc-onchain/verum-otc-onchain';
const OUT = `${ONCHAIN}/contracts/evm/out`;
const TX_GAS_CAP = 16_777_216n; // EIP-7825

// ── Gates de segurança (mainnet = dinheiro real) ─────────────────────────────
if (process.env.MAINNET_AUTHORIZED !== 'true') { console.error('MAINNET_AUTHORIZED=true é obrigatório (gate do repo onchain: auditoria + aprovação).'); process.exit(1); }
if (process.env.CONFIRM_MAINNET !== 'yes') { console.error('CONFIRM_MAINNET=yes é obrigatório — este deploy gasta ETH REAL (~9–10M de gás).'); process.exit(1); }
const RPC = process.env.MAINNET_RPC_URL;
const KEY = process.env.MAINNET_DEPLOYER_KEY as `0x${string}` | undefined;
const ATTESTOR = process.env.MAINNET_ATTESTOR_ADDRESS as `0x${string}` | undefined;
if (!RPC || !KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) { console.error('MAINNET_RPC_URL e MAINNET_DEPLOYER_KEY (0x+64 hex) são obrigatórios.'); process.exit(1); }
if (!ATTESTOR || !/^0x[0-9a-fA-F]{40}$/.test(ATTESTOR)) { console.error('MAINNET_ATTESTOR_ADDRESS (0x+40 hex) é obrigatório — endereço PÚBLICO do attestor (a chave fica só no backend).'); process.exit(1); }

const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
const deployer = privateKeyToAccount(KEY);
const owner = (process.env.OWNER_ADDRESS as `0x${string}` | undefined) ?? deployer.address;
const guardian = (process.env.GUARDIAN_ADDRESS as `0x${string}` | undefined) ?? owner;
const treasury = (process.env.TREASURY_ADDRESS_MAINNET as `0x${string}` | undefined) ?? owner;
const w = createWalletClient({ chain: mainnet, transport: http(RPC), account: deployer });

const chainId = await pub.getChainId();
if (chainId !== 1) { console.error(`RPC não é a mainnet (chainId ${chainId}).`); process.exit(1); }

const artifact = (rel: string): { abi: unknown[]; bytecode: string } => {
  const j = JSON.parse(readFileSync(`${OUT}/${rel}`, 'utf8')) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: j.abi, bytecode: j.bytecode.object };
};

const bal = await pub.getBalance({ address: deployer.address });
const gasPrice = await pub.getGasPrice();
const estCost = (2_500_000n + 7_200_000n + 4n * 250_000n) * gasPrice; // lib + escrow + 4 addToken
console.log(`deployer  ${deployer.address} — saldo ${formatEther(bal)} ETH`);
console.log(`owner     ${owner}${owner === deployer.address ? ' (deployer — transferir ao Safe depois)' : ''}`);
console.log(`guardian  ${guardian} | treasury ${treasury} | attestor ${ATTESTOR}`);
console.log(`gasPrice  ${Number(gasPrice) / 1e9} gwei — custo estimado ≈ ${formatEther(estCost)} ETH`);
if (bal < estCost * 2n) { console.error(`saldo insuficiente: precisa de ≥ ${formatEther(estCost * 2n)} ETH (estimativa ×2 de folga).`); process.exit(1); }

const deploy = async (label: string, abi: unknown[], bytecode: `0x${string}`, args: unknown[], gas: bigint): Promise<`0x${string}`> => {
  if (gas > TX_GAS_CAP) throw new Error(`${label}: gás ${gas} acima do teto EIP-7825`);
  console.log(`deployando ${label}… (gás ${gas})`);
  const data = encodeDeployData({ abi: abi as never, bytecode, args: args as never });
  const hash = await w.sendTransaction({ data, gas });
  console.log(`  tx ${hash}`);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (rc.status !== 'success' || !rc.contractAddress) throw new Error(`${label}: deploy reverteu (${hash})`);
  console.log(`  ${label} → ${rc.contractAddress} (gás usado ${rc.gasUsed})`);
  return rc.contractAddress;
};

// 1) VerumV2Lib
const lib = artifact('VerumV2Lib.sol/VerumV2Lib.json');
const libAddr = await deploy('VerumV2Lib', lib.abi, lib.bytecode as `0x${string}`, [], 4_000_000n);

// 2) Link do placeholder da lib no bytecode do escrow
const esc = artifact('VerumOTCEscrowV2EVM.sol/VerumOTCEscrowV2EVM.json');
const placeholderHash = keccak256(toHex('src/VerumV2Lib.sol:VerumV2Lib')).slice(2, 36);
const linked = esc.bytecode.replaceAll(`__$${placeholderHash}$__`, libAddr.slice(2).toLowerCase());
if (linked.includes('__$')) throw new Error('bytecode ainda tem placeholder de link não resolvido');

// 3) Escrow (expectedChainId=1, owner, guardian, attestor, treasury)
const escAddr = await deploy('VerumOTCEscrowV2EVM', esc.abi, linked as `0x${string}`,
  [1n, owner, guardian, ATTESTOR, treasury], 10_500_000n);

// 4) Tokens REAIS no registry on-chain (ETH nativo usa a sentinela — não entra)
const ESCROW_ABI = [
  { type: 'function', name: 'addToken', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'decimals_', type: 'uint8' }, { name: 'symbol_', type: 'string' }], outputs: [] },
  { type: 'function', name: 'isTokenActive', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'NATIVE_ASSET', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;
const TOKENS = [
  [ETH_MAINNET_TOKENS.USDT.address, 6, 'USDT'],
  [ETH_MAINNET_TOKENS.USDC.address, 6, 'USDC'],
  [ETH_MAINNET_TOKENS.WBTC.address, 8, 'WBTC'],
  [ETH_MAINNET_TOKENS.WETH.address, 18, 'WETH'],
] as const;
for (const [token, decimals, symbol] of TOKENS) {
  console.log(`addToken ${symbol}…`);
  const h = await w.writeContract({ address: escAddr, abi: ESCROW_ABI, functionName: 'addToken', args: [token, decimals, symbol], gas: 300_000n });
  await pub.waitForTransactionReceipt({ hash: h, timeout: 600_000 });
}

// 5) Verificação pós-deploy
const checks = {
  owner: await pub.readContract({ address: escAddr, abi: ESCROW_ABI, functionName: 'owner' }),
  paused: await pub.readContract({ address: escAddr, abi: ESCROW_ABI, functionName: 'paused' }),
  native: await pub.readContract({ address: escAddr, abi: ESCROW_ABI, functionName: 'NATIVE_ASSET' }),
  tokens: Object.fromEntries(await Promise.all(TOKENS.map(async ([t, , s]) => [s, await pub.readContract({ address: escAddr, abi: ESCROW_ABI, functionName: 'isTokenActive', args: [t] })]))),
};
console.log('\n===== DEPLOY MAINNET CONCLUÍDO =====');
console.log(`VerumV2Lib:   ${libAddr}`);
console.log(`Escrow V2:    ${escAddr}`);
console.log('checks:', JSON.stringify(checks));
console.log(`\nEnvs do backend (local e Vercel):`);
console.log(`VERUM_EVM_MAINNET_RPC_URL=${RPC}`);
console.log(`VERUM_EVM_MAINNET_ESCROW_V2_ADDRESS=${escAddr}`);
console.log(`VERUM_EVM_MAINNET_KEEPER_KEY=0x<chave-quente-do-keeper — NUNCA o owner>`);
console.log(`VERUM_EVM_MAINNET_ATTESTOR_KEY=0x<chave-do-attestor>`);
console.log(`\nPróximos: abastecer o keeper (~0,01 ETH p/ settles) e, quando tiver o Safe:`);
console.log(`  npx tsx scripts/escrow-v2-owner-ops.mts --skip-addtoken --transfer-to 0x<Safe>`);
