/**
 * E2E REAL da perna NATIVA (ETH puro) no escrow V2 da Sepolia: mesa bilateral em que o Vendedor
 * entrega tUSDT e o Comprador paga ETH NATIVO (sem WETH em nenhum ponto):
 *   createTradeV2 → signV2 do Vendedor (approve+pull tUSDT) → signV2 do Comprador {value} →
 *   settleV2 → confere: Vendedor recebeu o ETH, Comprador recebeu o tUSDT.
 * Carteiras descartáveis; keeper abastece gás e minta o tUSDT.
 * Uso: npx tsx --env-file=.env scripts/smoke-native-eth.mts
 */
import { createPublicClient, createWalletClient, http, parseEther, formatEther, type Abi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { loadConfig, verumEvmConfig } from '../src/config.js';
import { signWalletAttestationEvm, computeTradeIdEvm } from '../src/onchain/crypto/index.js';
import { NATIVE_ASSET_EVM } from '../src/onchain/core/index.js';
import { Role as OnchainRole } from '../src/onchain/types.js';
import ESCROW_ABI_JSON from '../src/onchain/router/abi/verumOtcEscrowV2.js';

const ABI = ESCROW_ABI_JSON as Abi;
const config = loadConfig(process.env);
const evm = verumEvmConfig(config);
if (!evm?.escrowV2) { console.error('VERUM_EVM_* + VERUM_EVM_V2_ESCROW_ADDRESS exigidos'); process.exit(1); }
const ESCROW = evm.escrowV2;
const pub = createPublicClient({ chain: sepolia, transport: http(evm.rpcUrl) });
const keeper = privateKeyToAccount(evm.keeperKey);
const keeperW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: keeper });

const seller = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey());
console.log(`escrow ${ESCROW}\nvendedor ${seller.address} (entrega tUSDT)\ncomprador ${buyer.address} (paga ETH NATIVO)`);

const SELL = 1_000_000n;            // 1 tUSDT
const BUY = parseEther('0.0005');   // ETH nativo do comprador
const wait = (h: `0x${string}`) => pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });

// gás + tUSDT
const ERC20 = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
console.log('abastecendo carteiras (gás + valor do comprador + tUSDT do vendedor)…');
await wait(await keeperW.sendTransaction({ to: seller.address, value: parseEther('0.002') }));
await wait(await keeperW.sendTransaction({ to: buyer.address, value: BUY + parseEther('0.002') }));
await wait(await keeperW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'mint', args: [seller.address, SELL * 2n] }));

// termos: vendedor tUSDT ↔ comprador ETH NATIVO (bilateral, sem PMs/comissões)
const now = Number((await pub.getBlock()).timestamp);
const terms = {
  participants: [
    { wallet: seller.address, role: 0 },
    { wallet: buyer.address, role: 3 },
  ],
  sellerAsset: evm.tusdt, sellerAmount: SELL,
  buyerAsset: NATIVE_ASSET_EVM as `0x${string}`, buyerAmount: BUY,
  platformFeeBps: 3, commissionBps: 0, discountBps: 0, slippageBps: 0,
  createdAt: BigInt(now), expiresAt: BigInt(now + 2400), termsVersion: 2,
  nonce: BigInt(Date.now()), htlcHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
  commissionPm1: 0n, commissionPm2: 0n, dealType: 0, swapRouter: ('0x' + '0'.repeat(40)) as `0x${string}`, minAmountOut: 0n,
};
const termsHash = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'hashTermsV2', args: [terms] }) as `0x${string}`;
const tradeId = computeTradeIdEvm(evm.chainId, ESCROW, termsHash);
console.log(`tradeId ${tradeId}`);

const att = async (wallet: string) => {
  const a = await signWalletAttestationEvm(evm.attestorKey as `0x${string}`, evm.chainId, ESCROW, wallet, now + 3600);
  return { validUntil: BigInt(a.validUntil), signature: a.signature as `0x${string}` };
};
const sellerW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: seller });
const buyerW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: buyer });

console.log('createTradeV2 (vendedor cria — mesa bilateral)…');
await wait(await sellerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'createTradeV2', args: [terms, [await att(seller.address), await att(buyer.address)]] }));

console.log('signV2 do Vendedor (approve + pull do tUSDT + fee)…');
const fee = (SELL * 3n) / 10_000n;
await wait(await sellerW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'approve', args: [ESCROW, SELL + fee] }));
const deadline = now + 2300;
// Assina o Approval EIP-712 direto com o viem (mesmo digest que o adapter/signApprovalEvm produz):
const sign = async (acc: typeof seller, role: number) => {
  const digestTyped = {
    domain: { name: 'VerumOTC', version: '1', chainId: BigInt(evm.chainId), verifyingContract: ESCROW },
    types: { Approval: [{ name: 'tradeId', type: 'bytes32' }, { name: 'termsHash', type: 'bytes32' }, { name: 'role', type: 'uint8' }, { name: 'deadline', type: 'uint64' }] },
    primaryType: 'Approval' as const,
    message: { tradeId: tradeId as `0x${string}`, termsHash, role, deadline: BigInt(deadline) },
  };
  return acc.signTypedData(digestTyped as Parameters<typeof acc.signTypedData>[0]);
};
await wait(await sellerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(deadline), await sign(seller, OnchainRole.SELLER)] }));

console.log(`signV2 do Comprador com value=${formatEther(BUY)} ETH (SEM approve, SEM wrap)…`);
await wait(await buyerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(deadline), await sign(buyer, OnchainRole.BUYER)], value: BUY }));

const sellerEthBefore = await pub.getBalance({ address: seller.address });
console.log('settleV2 (keeper executa)…');
await wait(await keeperW.writeContract({ address: ESCROW, abi: ABI, functionName: 'settleV2', args: [tradeId, '0x'] }));

const sellerEthAfter = await pub.getBalance({ address: seller.address });
const buyerUsdt = await pub.readContract({ address: evm.tusdt, abi: ERC20, functionName: 'balanceOf', args: [buyer.address] }) as bigint;
console.log('\n===== resultado =====');
console.log(`Vendedor recebeu ETH nativo: +${formatEther(sellerEthAfter - sellerEthBefore)} (esperado ${formatEther(BUY)})`);
console.log(`Comprador recebeu tUSDT: ${buyerUsdt} (esperado ${SELL})`);
if (sellerEthAfter - sellerEthBefore === BUY && buyerUsdt === SELL) console.log('✓ SWAP ETH-NATIVO LIQUIDADO PONTA A PONTA');
else { console.error('✗ valores divergentes'); process.exit(1); }
