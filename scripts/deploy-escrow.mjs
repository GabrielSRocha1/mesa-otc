// Deploy do VerumOtcEscrow + tokens mock (tBTC/tUSDT) numa rede EVM de teste (Sepolia ou anvil).
// Uso: EVM_RPC_URL=... EVM_KEEPER_KEY=0x... [EVM_CHAIN_ID=11155111] [TREASURY_ADDRESS=0x...] node scripts/deploy-escrow.mjs
// Saída: bloco .env pronto para colar + contracts/out/deploy.<chainId>.json (auditoria).
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const art = (name) => JSON.parse(readFileSync(new URL(`../contracts/out/${name}.json`, import.meta.url), 'utf8'));

const RPC = process.env.EVM_RPC_URL;
const KEY = process.env.EVM_KEEPER_KEY;
if (!RPC || !KEY) {
  console.error('Faltam envs: EVM_RPC_URL e EVM_KEEPER_KEY são obrigatórias.');
  console.error('Exemplo (Sepolia): EVM_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com EVM_KEEPER_KEY=0x... node scripts/deploy-escrow.mjs');
  process.exit(1);
}

const keeper = privateKeyToAccount(KEY);
const probe = createPublicClient({ transport: http(RPC) });
const chainId = await probe.getChainId();
if (process.env.EVM_CHAIN_ID && String(chainId) !== String(process.env.EVM_CHAIN_ID)) {
  console.error(`EVM_CHAIN_ID=${process.env.EVM_CHAIN_ID} não bate com o chainId real do RPC (${chainId}). Abortando.`);
  process.exit(1);
}
const chain = defineChain({ id: chainId, name: `evm-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account: keeper });

const treasury = process.env.TREASURY_ADDRESS || keeper.address;
const bal = await pub.getBalance({ address: keeper.address });
console.log(`Rede ${chainId} · keeper ${keeper.address} · saldo ${Number(bal) / 1e18} ETH · treasury ${treasury}`);
if (bal === 0n) { console.error('Keeper sem ETH para gás. Use um faucet (Sepolia) ou financie a conta.'); process.exit(1); }

async function deploy(name, a, args) {
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success' || !rc.contractAddress) throw new Error(`deploy de ${name} falhou (tx ${hash})`);
  console.log(`✓ ${name} → ${rc.contractAddress} (tx ${hash})`);
  return { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber) };
}

const ERC20 = art('MockERC20');
const ESCROW = art('VerumOtcEscrow');
const assetId = (addr) => `eip155:${chainId}/erc20:${addr.toLowerCase()}`;
const canonical = (addr) => keccak256(stringToHex(assetId(addr)));
const nativeCanonical = keccak256(stringToHex(`eip155:${chainId}/slip44:60`));

const tbtc = await deploy('MockERC20 tBTC', ERC20, ['Test BTC', 'tBTC', 8]);
const tusdt = await deploy('MockERC20 tUSDT', ERC20, ['Test USDT', 'tUSDT', 6]);
const escrow = await deploy('VerumOtcEscrow', ESCROW, [
  keeper.address, keeper.address, keeper.address, treasury,
  '0x0000000000000000000000000000000000000000', // sem priceGuard on-chain em dev; a guarda off-chain (§7.3) permanece
  nativeCanonical,
  [
    { token: tbtc.address, decimals: 8, canonicalId: canonical(tbtc.address) },
    { token: tusdt.address, decimals: 6, canonicalId: canonical(tusdt.address) },
  ],
]);

// Mint de conveniência: --fund 0xA,0xB recebe 10 tBTC e 1.000.000 tUSDT cada.
const fundArg = process.argv.find((a) => a.startsWith('--fund'));
if (fundArg) {
  const list = (fundArg.split('=')[1] || process.argv[process.argv.indexOf(fundArg) + 1] || '').split(',').filter(Boolean);
  for (const to of list) {
    for (const [tok, amt] of [[tbtc.address, 10n * 10n ** 8n], [tusdt.address, 1_000_000n * 10n ** 6n]]) {
      const h = await wallet.writeContract({ address: tok, abi: ERC20.abi, functionName: 'mint', args: [to, amt] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    console.log(`✓ fund ${to} (10 tBTC + 1.000.000 tUSDT)`);
  }
}

const out = {
  chainId, deployedAt: new Date().toISOString(), keeper: keeper.address, treasury,
  escrow, tbtc: { ...tbtc, assetId: assetId(tbtc.address) }, tusdt: { ...tusdt, assetId: assetId(tusdt.address) },
};
const outPath = new URL(`../contracts/out/deploy.${chainId}.json`, import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nRegistro gravado em contracts/out/deploy.${chainId}.json`);

console.log('\n# ── Cole no seu .env ─────────────────────────────');
console.log(`EVM_RPC_URL=${RPC}`);
console.log(`EVM_CHAIN_ID=${chainId}`);
console.log(`EVM_ESCROW_ADDRESS=${escrow.address}`);
console.log(`EVM_KEEPER_KEY=${KEY}`);
console.log(`EVM_TBTC=${tbtc.address}`);
console.log(`EVM_TUSDT=${tusdt.address}`);
if (chainId === 11155111) console.log('EVM_EXPLORER_BASE=https://sepolia.etherscan.io');
console.log('EVM_CONFIRMATIONS=' + (chainId === 31337 ? '1' : '2'));
console.log('# ─────────────────────────────────────────────────');
