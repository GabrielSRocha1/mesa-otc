/**
 * Operações de OWNER no escrow V2 (Sepolia) — executa as duas pendências do "ETH como token":
 *   addToken(WETH, 18, "WETH")  → ativa o WETH na allowlist on-chain (destrava ESCROW_DIRECT)
 *
 * Transferência de ownership é OPT-IN e o destino deve ser um MULTISIG (Safe), nunca o keeper:
 * o portal é público — uma chave quente dona do contrato controlaria pausa/config/allowlist de todos.
 *   --transfer-to 0xSafe...     → transferOwnership(multisig)  (addToken futuro passa a ser via Safe)
 *
 * A chave do owner NUNCA fica em arquivo: passe-a só no momento da execução —
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/escrow-v2-owner-ops.mts
 * Flags: --skip-addtoken (só transferir) · --transfer-to 0x... (opcional)
 */
import { createPublicClient, createWalletClient, http, parseAbi, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}

// Mesmo endereço canônico usado em src/app.ts (WETH_SEPOLIA).
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as const;
const escrow = env.VERUM_EVM_V2_ESCROW_ADDRESS as `0x${string}`;
const keeper = privateKeyToAccount(env.VERUM_EVM_KEEPER_KEY as `0x${string}`).address;
const ownerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!ownerKey) { console.error('Falta DEPLOYER_PRIVATE_KEY no ambiente (passe inline ao rodar; não grave em arquivo).'); process.exit(1); }

const abi = parseAbi([
  'function owner() view returns (address)',
  'function isTokenActive(address) view returns (bool)',
  'function addToken(address token, uint8 decimals, string symbol)',
  'function transferOwnership(address newOwner)',
]);

const account = privateKeyToAccount(ownerKey);
const pub = createPublicClient({ chain: sepolia, transport: http(env.VERUM_EVM_RPC_URL) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.VERUM_EVM_RPC_URL) });

const onchainOwner = await pub.readContract({ address: escrow, abi, functionName: 'owner' });
if (onchainOwner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`A chave fornecida deriva ${account.address}, mas o owner do escrow é ${onchainOwner}. Abortando.`);
  process.exit(1);
}
console.log(`owner confirmado: ${account.address} · saldo ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);

async function send(label: string, fn: 'addToken' | 'transferOwnership', args: readonly unknown[]) {
  const { request } = await pub.simulateContract({ address: escrow, abi, functionName: fn, args: args as never, account });
  const hash = await wallet.writeContract(request);
  console.log(`${label}: tx ${hash} — aguardando confirmação…`);
  const rec = await pub.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${rec.status === 'success' ? 'CONFIRMADA' : 'FALHOU'} (bloco ${rec.blockNumber})`);
  if (rec.status !== 'success') process.exit(1);
}

if (!process.argv.includes('--skip-addtoken')) {
  if (await pub.readContract({ address: escrow, abi, functionName: 'isTokenActive', args: [WETH] })) {
    console.log('addToken: WETH já ativo — pulando.');
  } else {
    await send('addToken(WETH)', 'addToken', [WETH, 18, 'WETH']);
  }
}

const transferIdx = process.argv.indexOf('--transfer-to');
if (transferIdx !== -1) {
  const dest = process.argv[transferIdx + 1];
  if (!dest || !/^0x[0-9a-fA-F]{40}$/.test(dest)) { console.error('--transfer-to exige um endereço 0x… (use um multisig/Safe).'); process.exit(1); }
  if (dest.toLowerCase() === keeper.toLowerCase()) {
    // Guard-rail: portal público → o keeper (chave quente do backend) jamais pode ser o owner.
    console.error('Recusado: o destino é o KEEPER (chave quente). Transfira para um multisig (Safe).');
    process.exit(1);
  }
  await send(`transferOwnership(${dest})`, 'transferOwnership', [dest as `0x${string}`]);
}

const finalOwner = await pub.readContract({ address: escrow, abi, functionName: 'owner' });
console.log(JSON.stringify({
  wethActive: await pub.readContract({ address: escrow, abi, functionName: 'isTokenActive', args: [WETH] }),
  owner: finalOwner,
  ownerIsHotKeeper: finalOwner.toLowerCase() === keeper.toLowerCase(), // deve ser SEMPRE false
}, null, 2));
