/**
 * Deploy do escrow V2 com PERNA NATIVA (ETH puro) na Sepolia — VerumV2Lib nova + escrow linkado.
 *
 * Pós-Fusaka (repreciação do depósito de código) o forge SUBESTIMA o gás do deploy — por isso o
 * deploy é via viem com GÁS EXPLÍCITO (o teto de 16,7M por tx do EIP-7825 não está ativo na
 * Sepolia). Owner/guardian/treasury = keeper (testnet, documentado em escrow-owner-governance).
 *
 * Passos: 1) deploya a VerumV2Lib; 2) linka o placeholder no bytecode do escrow; 3) deploya o
 * escrow; 4) addToken (tUSDT, tBTC, WETH). Imprime as linhas de .env ao final.
 *
 * Uso: npx tsx --env-file=.env scripts/deploy-escrow-v2-native.mts [caminho-do-repo-onchain]
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, encodeDeployData, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { loadConfig, verumEvmConfig, PLATFORM_TREASURY } from '../src/config.js';

const ONCHAIN = process.argv[2] ?? 'C:/Users/gabri/Downloads/verum-otc-onchain/verum-otc-onchain';
const OUT = `${ONCHAIN}/contracts/evm/out`;
const WETH_SEPOLIA = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

const config = loadConfig(process.env);
const evm = verumEvmConfig(config);
if (!evm) { console.error('VERUM_EVM_* ausente no .env'); process.exit(1); }

const pub = createPublicClient({ chain: sepolia, transport: http(evm.rpcUrl) });
const keeper = privateKeyToAccount(evm.keeperKey);
const attestor = privateKeyToAccount(evm.attestorKey as `0x${string}`);
const w = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: keeper });

const artifact = (rel: string): { abi: unknown[]; bytecode: string } => {
  const j = JSON.parse(readFileSync(`${OUT}/${rel}`, 'utf8')) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: j.abi, bytecode: j.bytecode.object };
};

const bal = await pub.getBalance({ address: keeper.address });
console.log(`keeper ${keeper.address} — saldo ${Number(bal) / 1e18} ETH`);
// ~50M de gás a <0,01 gwei (Sepolia típica) custa <0,001 ETH; 0,01 ETH dá folga p/ picos.
if (bal < 10_000_000_000_000_000n) { console.error('keeper precisa de ≥0,01 ETH Sepolia para o deploy'); process.exit(1); }

const deploy = async (label: string, abi: unknown[], bytecode: `0x${string}`, args: unknown[], gas: bigint): Promise<`0x${string}`> => {
  console.log(`deployando ${label}…`);
  const data = encodeDeployData({ abi: abi as never, bytecode, args: args as never });
  const hash = await w.sendTransaction({ data, gas });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== 'success' || !rc.contractAddress) throw new Error(`${label}: deploy reverteu (${hash})`);
  console.log(`  ${label} → ${rc.contractAddress} (gás usado ${rc.gasUsed})`);
  return rc.contractAddress;
};

// 1) VerumV2Lib nova (código novo: depósitos + payout nativo)
const lib = artifact('VerumV2Lib.sol/VerumV2Lib.json');
const libAddr = await deploy('VerumV2Lib', lib.abi, lib.bytecode as `0x${string}`, [], 12_000_000n);

// 2) Escrow: substitui o placeholder de link da lib no bytecode (formato __$<keccak do caminho>$__)
const esc = artifact('VerumOTCEscrowV2EVM.sol/VerumOTCEscrowV2EVM.json');
const placeholderHash = keccak256(toHex('src/VerumV2Lib.sol:VerumV2Lib')).slice(2, 36);
const linked = esc.bytecode.replaceAll(`__$${placeholderHash}$__`, libAddr.slice(2).toLowerCase());
if (linked.includes('__$')) throw new Error('bytecode ainda tem placeholder de link não resolvido');

// 3) Deploy do escrow (chainId, owner, guardian, attestor, treasury)
// owner/guardian = keeper (testnet, documentado); treasury = carteira de fee da plataforma.
const escAddr = await deploy('VerumOTCEscrowV2EVM', esc.abi, linked as `0x${string}`,
  [11155111n, keeper.address, keeper.address, attestor.address, PLATFORM_TREASURY.evm], 50_000_000n);

// 4) Tokens ACTIVE no registry (o NATIVO não entra: sentinela dispensa registry)
const ESCROW_ABI = [
  { type: 'function', name: 'addToken', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'decimals_', type: 'uint8' }, { name: 'symbol_', type: 'string' }], outputs: [] },
  { type: 'function', name: 'NATIVE_ASSET', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
for (const [token, decimals, symbol] of [[evm.tusdt, 6, 'tUSDT'], [evm.tbtc, 8, 'tBTC'], [WETH_SEPOLIA, 18, 'WETH']] as const) {
  console.log(`addToken ${symbol}…`);
  const h = await w.writeContract({ address: escAddr, abi: ESCROW_ABI, functionName: 'addToken', args: [token as `0x${string}`, decimals, symbol], gas: 300_000n });
  await pub.waitForTransactionReceipt({ hash: h });
}
const nativeSentinel = await pub.readContract({ address: escAddr, abi: ESCROW_ABI, functionName: 'NATIVE_ASSET' });

console.log('\n===== deploy concluído =====');
console.log(`VerumV2Lib:      ${libAddr}`);
console.log(`Escrow V2:       ${escAddr}`);
console.log(`NATIVE_ASSET:    ${nativeSentinel}`);
console.log(`\nAtualize no .env (local e Vercel):`);
console.log(`VERUM_EVM_V2_ESCROW_ADDRESS=${escAddr}`);
