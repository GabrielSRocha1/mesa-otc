/**
 * E2E REAL de REEMBOLSO da perna NATIVA (ETH puro) no escrow V2 da Sepolia.
 * Mesa bilateral (Vendedor entrega tUSDT, Comprador paga ETH NATIVO) que NÃO liquida:
 *   createTradeV2 → signV2 do Vendedor (approve+pull tUSDT) → signV2 do Comprador {value ETH} →
 *   [espera passar expiresAt] → expireAndRefundV2 → confere:
 *     Comprador recebeu DE VOLTA o ETH nativo; Vendedor recebeu DE VOLTA o tUSDT.
 * Diferente do smoke-native-eth.mts (que liquida), aqui a janela expira e ninguém liquida.
 * Carteiras descartáveis; keeper abastece gás, minta o tUSDT e executa o refund.
 * IMPORTANTE: aponte para o escrow NATIVO (0xa749da89…). O v2.2 antigo (0x3f3b8dfd) reverte NATIVE_ASSET().
 * Uso: VERUM_EVM_V2_ESCROW_ADDRESS=0xa749da893be8f20c56ef42e3d4440808c839c296 npx tsx --env-file=.env scripts/smoke-native-eth-refund.mts
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

// guarda-costas: refund nativo só existe no escrow com perna nativa
try {
  const na = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'NATIVE_ASSET' }) as string;
  console.log(`escrow ${ESCROW} · NATIVE_ASSET=${na}`);
} catch {
  console.error(`✗ ${ESCROW} não expõe NATIVE_ASSET() — é o escrow v2.2 antigo (WETH). Aponte para 0xa749da89…`);
  process.exit(1);
}

const seller = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey());
console.log(`vendedor ${seller.address} (deposita tUSDT)\ncomprador ${buyer.address} (deposita ETH NATIVO)`);

const SELL = 1_000_000n;            // 1 tUSDT
const BUY = parseEther('0.0005');   // ETH nativo do comprador
const wait = (h: `0x${string}`) => pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });

const ERC20 = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
console.log('abastecendo carteiras (gás + valor do comprador + tUSDT do vendedor)…');
await wait(await keeperW.sendTransaction({ to: seller.address, value: parseEther('0.002') }));
await wait(await keeperW.sendTransaction({ to: buyer.address, value: BUY + parseEther('0.002') }));
await wait(await keeperW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'mint', args: [seller.address, SELL * 2n] }));

// A janela é FIXA (TRADE_DURATION=2400s) e _validateTimestamps exige:
//   |createdAt - block.timestamp| <= CREATION_WINDOW (5 min)  E  expiresAt == createdAt + 2400.
// Logo NÃO dá pra encurtar a janela livremente: o máximo é retroagir createdAt ~CREATION_WINDOW,
// deixando margem p/ o drift do bloco entre a leitura e a mineração do createTradeV2 (~250s).
// Mesmo assim o refund só é aceito após expiresAt → a espera é inerente (~36 min). fee=3bps é obrigatória.
const FEE = (SELL * 3n) / 10_000n;   // vendedor deposita SELL+FEE; refund devolve tudo
const TRADE_DURATION = 2400;
const now = Number((await pub.getBlock()).timestamp);
const CREATED = now - 250;                 // retroagido o quanto a janela de 5min permite (c/ margem)
const EXPIRES = CREATED + TRADE_DURATION;  // obrigatório == createdAt + 2400 (~now + 2150)
const DEADLINE = EXPIRES - 10;             // assinaturas válidas até pouco antes do vencimento
const terms = {
  participants: [
    { wallet: seller.address, role: 0 },
    { wallet: buyer.address, role: 3 },
  ],
  sellerAsset: evm.tusdt, sellerAmount: SELL,
  buyerAsset: NATIVE_ASSET_EVM as `0x${string}`, buyerAmount: BUY,
  platformFeeBps: 3, commissionBps: 0, discountBps: 0, slippageBps: 0,
  createdAt: BigInt(CREATED), expiresAt: BigInt(EXPIRES), termsVersion: 2,
  nonce: BigInt(Date.now()), htlcHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
  commissionPm1: 0n, commissionPm2: 0n, dealType: 0, swapRouter: ('0x' + '0'.repeat(40)) as `0x${string}`, minAmountOut: 0n,
};
const termsHash = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'hashTermsV2', args: [terms] }) as `0x${string}`;
const tradeId = computeTradeIdEvm(evm.chainId, ESCROW, termsHash);
console.log(`tradeId ${tradeId} · createdAt=${CREATED} expiresAt=${EXPIRES} (expira em ~${Math.round((EXPIRES - now) / 60)}min)`);

const att = async (wallet: string) => {
  const a = await signWalletAttestationEvm(evm.attestorKey as `0x${string}`, evm.chainId, ESCROW, wallet, now + 3600);
  return { validUntil: BigInt(a.validUntil), signature: a.signature as `0x${string}` };
};
const sellerW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: seller });
const buyerW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: buyer });

const sign = async (acc: typeof seller, role: number) => {
  const digestTyped = {
    domain: { name: 'VerumOTC', version: '1', chainId: BigInt(evm.chainId), verifyingContract: ESCROW },
    types: { Approval: [{ name: 'tradeId', type: 'bytes32' }, { name: 'termsHash', type: 'bytes32' }, { name: 'role', type: 'uint8' }, { name: 'deadline', type: 'uint64' }] },
    primaryType: 'Approval' as const,
    message: { tradeId: tradeId as `0x${string}`, termsHash, role, deadline: BigInt(DEADLINE) },
  };
  return acc.signTypedData(digestTyped as Parameters<typeof acc.signTypedData>[0]);
};

console.log('createTradeV2 (vendedor cria)…');
await wait(await sellerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'createTradeV2', args: [terms, [await att(seller.address), await att(buyer.address)]] }));

console.log('signV2 do Vendedor (approve + pull do tUSDT + fee)…');
await wait(await sellerW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'approve', args: [ESCROW, SELL + FEE] }));
await wait(await sellerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(DEADLINE), await sign(seller, OnchainRole.SELLER)] }));

console.log(`signV2 do Comprador com value=${formatEther(BUY)} ETH (deposita nativo)…`);
await wait(await buyerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(DEADLINE), await sign(buyer, OnchainRole.BUYER)], value: BUY }));

// saldos logo após o funding (baseline do reembolso)
const sellerUsdtFunded = await pub.readContract({ address: evm.tusdt, abi: ERC20, functionName: 'balanceOf', args: [seller.address] }) as bigint;
const buyerEthFunded = await pub.getBalance({ address: buyer.address });
console.log(`depositado · vendedor tUSDT=${sellerUsdtFunded} · comprador ETH=${formatEther(buyerEthFunded)}`);

// espera a janela expirar (block.timestamp > expiresAt)
process.stdout.write('aguardando expiração da janela');
for (;;) {
  const ts = Number((await pub.getBlock()).timestamp);
  if (ts > EXPIRES) { console.log(`\nbloco ts=${ts} > expiresAt=${EXPIRES} ✓`); break; }
  process.stdout.write(`.(${EXPIRES - ts}s)`);
  await new Promise(r => setTimeout(r, 30_000));
}

console.log('expireAndRefundV2 (keeper executa — ninguém liquidou)…');
await wait(await keeperW.writeContract({ address: ESCROW, abi: ABI, functionName: 'expireAndRefundV2', args: [tradeId] }));

const sellerUsdtAfter = await pub.readContract({ address: evm.tusdt, abi: ERC20, functionName: 'balanceOf', args: [seller.address] }) as bigint;
const buyerEthAfter = await pub.getBalance({ address: buyer.address });

console.log('\n===== resultado =====');
const buyerBack = buyerEthAfter - buyerEthFunded;   // keeper paga o gás do refund → delta == BUY
const sellerBack = sellerUsdtAfter - sellerUsdtFunded;
// SEMÂNTICA do contrato (VerumV2Lib.depositSellerLeg): a fee é cobrada NO DEPÓSITO (signV2) e vai
// direto à treasury — só o PRINCIPAL fica em custódia. Logo o refund devolve o principal (não a fee).
console.log(`Comprador recebeu ETH nativo de volta: +${formatEther(buyerBack)} (esperado ${formatEther(BUY)} — perna sem fee)`);
console.log(`Vendedor recebeu tUSDT (principal) de volta: +${sellerBack} (esperado ${SELL}; a fee ${FEE} foi cobrada no depósito e NÃO é reembolsável)`);
if (buyerBack === BUY && sellerBack === SELL) console.log('✓ REEMBOLSO ETH-NATIVO CONFIRMADO (principal 100% de volta; fee retida por design)');
else { console.error('✗ valores de reembolso divergentes'); process.exit(1); }
