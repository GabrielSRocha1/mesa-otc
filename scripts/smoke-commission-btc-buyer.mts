/**
 * Smoke REAL (Sepolia) do modo v3 — COMPRADOR EXTERNO (paga BTC via HTLC) com comissão dos PMs:
 * o Vendedor vende tUSDT e deposita principal + fee + COMISSÃO no signV2; o Comprador só assina
 * (o pagamento dele é o lock BTC na outra rede); o settleV2 com a preimage paga o tUSDT ao
 * Comprador e a comissão ao PM1 na MESMA transação, revelando a preimage (gatilho do claim BTC).
 * Exige escrow com TERMS_VERSION_V2 = 3 (VERUM_EVM_V2_TERMS_VERSION=3 no .env).
 * Uso: npx tsx --env-file=.env scripts/smoke-commission-btc-buyer.mts
 */
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, http, parseEther, type Abi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { loadConfig, verumEvmConfig } from '../src/config.js';
import { signWalletAttestationEvm, computeTradeIdEvm } from '../src/onchain/crypto/index.js';
import { commissionInSellerAsset } from '../src/onchain/core/fee.js';
import { Role as OnchainRole } from '../src/onchain/types.js';
import ESCROW_ABI_JSON from '../src/onchain/router/abi/verumOtcEscrowV2.js';

const ABI = ESCROW_ABI_JSON as Abi;
const config = loadConfig(process.env);
const evm = verumEvmConfig(config);
if (!evm?.escrowV2) { console.error('VERUM_EVM_* + VERUM_EVM_V2_ESCROW_ADDRESS exigidos'); process.exit(1); }
if (evm.termsVersionV2 < 3) { console.error('escrow configurado não é v3 (VERUM_EVM_V2_TERMS_VERSION=3 exigido)'); process.exit(1); }
const ESCROW = evm.escrowV2;
const pub = createPublicClient({ chain: sepolia, transport: http(evm.rpcUrl) });
const keeper = privateKeyToAccount(evm.keeperKey);
const keeperW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: keeper });

const seller = privateKeyToAccount(generatePrivateKey());
const pm1 = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey());
console.log(`escrow ${ESCROW} (v3)\nvendedor ${seller.address} (tUSDT)\npm1 ${pm1.address}\ncomprador ${buyer.address} (BTC EXTERNO — só assina)`);

const SELL = 1_000_000n;  // 1 tUSDT
const SATS = 100_000n;    // perna externa (sats, só entra no hash)
const D = 200, C = 100;
const FEE = (SELL * 3n) / 10_000n;                       // 300
const COMMISSION = commissionInSellerAsset(SELL, D, C);  // 1e6 × 0,98 × 1% = 9.800
const PREIMAGE = Buffer.from('a1'.repeat(32), 'hex');
const HTLC_HASH = ('0x' + createHash('sha256').update(PREIMAGE).digest('hex')) as `0x${string}`;
const wait = (h: `0x${string}`) => pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });

const ERC20 = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
console.log('abastecendo carteiras (gás + tUSDT do vendedor)…');
await wait(await keeperW.sendTransaction({ to: seller.address, value: parseEther('0.002') }));
await wait(await keeperW.sendTransaction({ to: pm1.address, value: parseEther('0.002') }));
await wait(await keeperW.sendTransaction({ to: buyer.address, value: parseEther('0.002') }));
await wait(await keeperW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'mint', args: [seller.address, SELL * 2n] }));

const now = Number((await pub.getBlock()).timestamp);
const terms = {
  participants: [
    { wallet: seller.address, role: 0 },
    { wallet: pm1.address, role: 1 },
    { wallet: buyer.address, role: 3 },
  ],
  sellerAsset: evm.tusdt, sellerAmount: SELL,
  buyerAsset: ('0x' + '0'.repeat(40)) as `0x${string}`, buyerAmount: SATS, // perna EXTERNA (BTC)
  platformFeeBps: 3, commissionBps: C, discountBps: D, slippageBps: 0,
  createdAt: BigInt(now), expiresAt: BigInt(now + 2400), termsVersion: evm.termsVersionV2,
  nonce: BigInt(Date.now()), htlcHash: HTLC_HASH,
  commissionPm1: COMMISSION, commissionPm2: 0n, dealType: 0, swapRouter: ('0x' + '0'.repeat(40)) as `0x${string}`, minAmountOut: 0n,
};
const termsHash = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'hashTermsV2', args: [terms] }) as `0x${string}`;
const tradeId = computeTradeIdEvm(evm.chainId, ESCROW, termsHash);
console.log(`tradeId ${tradeId} · comissão ${COMMISSION} tUSDT-base ao PM1`);

const att = async (wallet: string) => {
  const a = await signWalletAttestationEvm(evm.attestorKey as `0x${string}`, evm.chainId, ESCROW, wallet, now + 3600);
  return { validUntil: BigInt(a.validUntil), signature: a.signature as `0x${string}` };
};
const walletOf = (acc: typeof seller) => createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: acc });
const sellerW = walletOf(seller); const pm1W = walletOf(pm1); const buyerW = walletOf(buyer);

console.log('createTradeV2 (PM1 cria)…');
await wait(await pm1W.writeContract({ address: ESCROW, abi: ABI, functionName: 'createTradeV2', args: [terms, [await att(seller.address), await att(pm1.address), await att(buyer.address)]] }));

const deadline = now + 2300;
const sign = async (acc: typeof seller, role: number) => acc.signTypedData({
  domain: { name: 'VerumOTC', version: '1', chainId: BigInt(evm.chainId), verifyingContract: ESCROW },
  types: { Approval: [{ name: 'tradeId', type: 'bytes32' }, { name: 'termsHash', type: 'bytes32' }, { name: 'role', type: 'uint8' }, { name: 'deadline', type: 'uint64' }] },
  primaryType: 'Approval',
  message: { tradeId: tradeId as `0x${string}`, termsHash, role, deadline: BigInt(deadline) },
} as Parameters<typeof seller.signTypedData>[0]);

console.log(`signV2 do Vendedor (approve + pull de ${SELL} + fee ${FEE} + comissão ${COMMISSION})…`);
await wait(await sellerW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'approve', args: [ESCROW, SELL + FEE + COMMISSION] }));
await wait(await sellerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(deadline), await sign(seller, OnchainRole.SELLER)] }));

console.log('signV2 do PM1 (sem depósito)…');
await wait(await pm1W.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(deadline), await sign(pm1, OnchainRole.PAYMASTER_01)] }));

console.log('signV2 do Comprador (externo — só assinatura, sem value)…');
await wait(await buyerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(deadline), await sign(buyer, OnchainRole.BUYER)] }));

console.log('settleV2 com a preimage (keeper executa)…');
await wait(await keeperW.writeContract({ address: ESCROW, abi: ABI, functionName: 'settleV2', args: [tradeId, ('0x' + PREIMAGE.toString('hex')) as `0x${string}`] }));

// Leituras com RETRY: RPC público balanceado pode servir 'latest' atrasado logo após o receipt.
const balOf = (a: string) => pub.readContract({ address: evm.tusdt, abi: ERC20, functionName: 'balanceOf', args: [a as `0x${string}`] }) as Promise<bigint>;
let buyerUsdt = 0n, pm1Usdt = 0n, escrowUsdt = -1n;
for (let i = 0; i < 10; i++) {
  [buyerUsdt, pm1Usdt, escrowUsdt] = await Promise.all([balOf(buyer.address), balOf(pm1.address), balOf(ESCROW)]);
  if (buyerUsdt === SELL && pm1Usdt === COMMISSION && escrowUsdt === 0n) break;
  await new Promise(r => setTimeout(r, 3000));
}
const revealed = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'revealedPreimage', args: [tradeId] }) as `0x${string}`;

console.log('\n===== resultado =====');
console.log(`Comprador recebeu tUSDT: ${buyerUsdt} (esperado ${SELL})`);
console.log(`PM1 recebeu comissão:   ${pm1Usdt} (esperado ${COMMISSION})`);
console.log(`Escrow tUSDT restante:  ${escrowUsdt} (esperado 0)`);
console.log(`Preimage revelada:      ${revealed === '0x' + PREIMAGE.toString('hex') ? '✓ (gatilho do claim BTC)' : '✗ ' + revealed}`);
if (buyerUsdt === SELL && pm1Usdt === COMMISSION && escrowUsdt === 0n && revealed === '0x' + PREIMAGE.toString('hex')) {
  console.log('✓ v3 PONTA A PONTA: comissão do PM paga na perna do Vendedor com comprador EXTERNO');
} else { console.error('✗ valores divergentes'); process.exit(1); }
