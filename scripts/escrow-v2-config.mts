/**
 * Troca de CONFIG (treasury/fee/attestor) do escrow V2 — governança com timelock de 24h.
 * O contrato só move a platform fee para a treasury ARMAZENADA nele; redirecionar a fee exige:
 *   1) proposeConfig(feeBps, treasury, attestor)  (onlyOwner) → arma o pending (executável em +24h)
 *   2) [esperar 24h]
 *   3) applyConfig()                               (onlyOwner) → troca de fato
 * Preserva feeBps e attestor atuais por padrão (só muda a treasury), salvo override por env.
 *
 * Chave do owner: NUNCA em arquivo. Passe inline em CONFIG_OWNER_KEY=0x... ; na Sepolia o owner é
 * o próprio keeper, então sem CONFIG_OWNER_KEY o script cai em VERUM_EVM_KEEPER_KEY do .env.
 * Rede: Sepolia por padrão (VERUM_EVM_* do .env). Para mainnet, aponte RPC/escrow/chave via env
 *   RPC_URL / ESCROW / CONFIG_OWNER_KEY (ex.: os VERUM_EVM_MAINNET_*).
 *
 * Uso (Sepolia, via .env):
 *   npx tsx --env-file=.env scripts/escrow-v2-config.mts --status
 *   npx tsx --env-file=.env scripts/escrow-v2-config.mts --propose
 *   npx tsx --env-file=.env scripts/escrow-v2-config.mts --apply
 *   npx tsx --env-file=.env scripts/escrow-v2-config.mts --cancel
 * Override treasury: NEW_TREASURY=0x... (default = PLATFORM_TREASURY.evm)
 */
import { createPublicClient, createWalletClient, http, parseAbi, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { PLATFORM_TREASURY } from '../src/config.js';

const RPC = process.env.RPC_URL ?? process.env.VERUM_EVM_RPC_URL;
const ESCROW = (process.env.ESCROW ?? process.env.VERUM_EVM_V2_ESCROW_ADDRESS) as `0x${string}` | undefined;
const OWNER_KEY = (process.env.CONFIG_OWNER_KEY ?? process.env.VERUM_EVM_KEEPER_KEY) as `0x${string}` | undefined;
const NEW_TREASURY = (process.env.NEW_TREASURY as `0x${string}` | undefined) ?? PLATFORM_TREASURY.evm;
if (!RPC || !ESCROW || !OWNER_KEY) { console.error('Faltam RPC_URL/ESCROW/CONFIG_OWNER_KEY (ou os VERUM_EVM_* no .env).'); process.exit(1); }

const action = process.argv.find(a => ['--status', '--propose', '--apply', '--cancel'].includes(a)) ?? '--status';

const abi = parseAbi([
  'function owner() view returns (address)',
  'function treasury() view returns (address)',
  'function attestor() view returns (address)',
  'function platformFeeBps() view returns (uint16)',
  'function pendingConfig() view returns (uint16 feeBps, address treasury, address attestor, uint64 executableAt, bool exists)',
  'function proposeConfig(uint16 feeBps, address treasury_, address attestor_)',
  'function applyConfig()',
  'function cancelConfig()',
]);

const account = privateKeyToAccount(OWNER_KEY);
const chainId = Number(process.env.VERUM_EVM_CHAIN_ID ?? '11155111');
const chain = chainId === 1 ? mainnet : sepolia;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const onchainOwner = await pub.readContract({ address: ESCROW, abi, functionName: 'owner' });
const [feeBps, treasury, attestor] = await Promise.all([
  pub.readContract({ address: ESCROW, abi, functionName: 'platformFeeBps' }),
  pub.readContract({ address: ESCROW, abi, functionName: 'treasury' }),
  pub.readContract({ address: ESCROW, abi, functionName: 'attestor' }),
]);
const pending = await pub.readContract({ address: ESCROW, abi, functionName: 'pendingConfig' }) as readonly [number, string, string, bigint, boolean];
const now = Number((await pub.getBlock()).timestamp);

const showStatus = () => {
  console.log(`escrow    ${ESCROW} (chainId ${chainId})`);
  console.log(`owner     ${onchainOwner}`);
  console.log(`ATUAL     feeBps=${feeBps} · treasury=${treasury} · attestor=${attestor}`);
  if (pending[4]) {
    const eta = Number(pending[3]) - now;
    console.log(`PENDENTE  feeBps=${pending[0]} · treasury=${pending[1]} · attestor=${pending[2]}`);
    console.log(`          executável em ${Number(pending[3])} (${eta > 0 ? `faltam ~${Math.ceil(eta / 60)} min` : 'JÁ EXECUTÁVEL — rode --apply'})`);
  } else console.log('PENDENTE  (nenhum)');
  console.log(`alvo desejado: treasury=${NEW_TREASURY}`);
};

if (action === '--status') { showStatus(); process.exit(0); }

if (onchainOwner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`A chave deriva ${account.address}, mas o owner é ${onchainOwner}. Abortando (precisa da chave do owner).`);
  process.exit(1);
}

const send = async (label: string, fn: 'proposeConfig' | 'applyConfig' | 'cancelConfig', args: readonly unknown[]) => {
  const { request } = await pub.simulateContract({ address: ESCROW, abi, functionName: fn, args: args as never, account });
  const hash = await wallet.writeContract(request);
  console.log(`${label}: tx ${hash} — aguardando…`);
  const rec = await pub.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${rec.status} (bloco ${rec.blockNumber})`);
  if (rec.status !== 'success') process.exit(1);
};

console.log(`owner confirmado ${account.address} · saldo ${formatEther(await pub.getBalance({ address: account.address }))} ETH\n`);

if (action === '--propose') {
  if (treasury.toLowerCase() === NEW_TREASURY.toLowerCase()) { console.log('treasury já é a desejada — nada a propor.'); process.exit(0); }
  await send(`proposeConfig(fee=${feeBps}, treasury=${NEW_TREASURY})`, 'proposeConfig', [feeBps, NEW_TREASURY, attestor]);
  console.log('\n→ Timelock de 24h armado. Rode --apply depois do executableAt (veja --status).');
} else if (action === '--apply') {
  if (!pending[4]) { console.error('Sem pendingConfig para aplicar.'); process.exit(1); }
  if (Number(pending[3]) > now) { console.error(`Ainda no timelock — faltam ~${Math.ceil((Number(pending[3]) - now) / 60)} min.`); process.exit(1); }
  await send('applyConfig()', 'applyConfig', []);
} else if (action === '--cancel') {
  await send('cancelConfig()', 'cancelConfig', []);
}

const finalTreasury = await pub.readContract({ address: ESCROW, abi, functionName: 'treasury' });
console.log(`\ntreasury agora: ${finalTreasury}`);
