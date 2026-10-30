/**
 * E2E REAL do PRÉ-PAGAMENTO DE GÁS (gas prepayment) no escrow nativo V2 da Sepolia.
 * Mesa bilateral same-network EVM (Vendedor entrega tUSDT, Comprador paga ETH nativo) → pagador do
 * gás = COMPRADOR. Prova as mecânicas que a feature introduz, direto contra o contrato:
 *   1) Comprador calcula o depósito dinâmico (ciclo × gasPrice × 3) e ENVIA ao keeper.
 *   2) verifyGasPrepay confirma (de=comprador, para=keeper, valor ≥ exigido).
 *   3) keeper ABASTECE o attestor (fundFromKeeper) e o ATTESTOR registra (createTradeV2 — o contrato
 *      aceita o attestor como criador; PM1 não envia nada).
 *   4) Vendedor/Comprador depositam (signV2); keeper LIQUIDA (settleV2).
 *   5) keeper DEVOLVE a sobra (depósito − ciclo×gasPrice) ao comprador. Confere a contabilidade.
 * Carteiras descartáveis; keeper abastece gás/tUSDT. Liquida dentro da janela (sem espera).
 * Uso: VERUM_EVM_V2_ESCROW_ADDRESS=0xa749da893be8f20c56ef42e3d4440808c839c296 npx tsx --env-file=.env scripts/smoke-gas-prepay.mts
 */
import { createPublicClient, createWalletClient, http, parseEther, formatEther, type Abi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { loadConfig, verumEvmConfig } from '../src/config.js';
import { signWalletAttestationEvm, computeTradeIdEvm } from '../src/onchain/crypto/index.js';
import { NATIVE_ASSET_EVM } from '../src/onchain/core/index.js';
import { Role as OnchainRole } from '../src/onchain/types.js';
import { estimateGasPrepayWei, lifecycleGasUnits, EVM_GAS_UNITS } from '../src/engines/gasPrepay.js';
import ESCROW_ABI_JSON from '../src/onchain/router/abi/verumOtcEscrowV2.js';

const ABI = ESCROW_ABI_JSON as Abi;
const config = loadConfig(process.env);
const evm = verumEvmConfig(config);
if (!evm?.escrowV2) { console.error('VERUM_EVM_* + VERUM_EVM_V2_ESCROW_ADDRESS exigidos'); process.exit(1); }
const ESCROW = evm.escrowV2;
const pub = createPublicClient({ chain: sepolia, transport: http(evm.rpcUrl) });
const wait = (h: `0x${string}`) => pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });

const keeper = privateKeyToAccount(evm.keeperKey);
const attestor = privateKeyToAccount(evm.attestorKey as `0x${string}`);
const keeperW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: keeper });
const attestorW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: attestor });

// guarda: precisa do escrow com perna nativa
try { await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'NATIVE_ASSET' }); }
catch { console.error(`✗ ${ESCROW} sem NATIVE_ASSET() — aponte para 0xa749da89…`); process.exit(1); }

const seller = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey()); // = pagador do gás (lado-EVM)
console.log(`escrow ${ESCROW}\nkeeper ${keeper.address} · attestor ${attestor.address}`);
console.log(`vendedor ${seller.address} (tUSDT) · comprador/pagador ${buyer.address} (ETH + gás)`);

const SELL = 1_000_000n, BUY = parseEther('0.0005'), FEE = (SELL * 3n) / 10_000n;
const ERC20 = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

// ───────────────────────────── 1) depósito dinâmico (ciclo × gasPrice × 3)
const gasPrice = await pub.getGasPrice();
const deposit = estimateGasPrepayWei(gasPrice);
console.log(`\ngasPrice ${(Number(gasPrice) / 1e9).toFixed(3)} gwei · ciclo ${lifecycleGasUnits()} gás → DEPÓSITO ${formatEther(deposit)} ETH`);

console.log('abastecendo carteiras…');
await wait(await keeperW.sendTransaction({ to: seller.address, value: parseEther('0.002') }));
await wait(await keeperW.sendTransaction({ to: buyer.address, value: BUY + deposit + parseEther('0.003') })); // valor + depósito + gás próprio
await wait(await keeperW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'mint', args: [seller.address, SELL * 2n] }));

const buyerW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: buyer });
const keeperBal0 = await pub.getBalance({ address: keeper.address });
console.log(`\n[1] Comprador envia o depósito de gás (${formatEther(deposit)} ETH) ao keeper…`);
const depTx = await buyerW.sendTransaction({ to: keeper.address, value: deposit, account: buyer, chain: sepolia });
await wait(depTx);

// ───────────────────────────── 2) verifyGasPrepay (replica a verificação do adapter)
console.log('[2] Verificando o depósito on-chain (de=comprador, para=keeper, valor ≥ exigido)…');
const dtx = await pub.getTransaction({ hash: depTx });
const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
if (!eq(dtx.to, keeper.address) || !eq(dtx.from, buyer.address) || dtx.value < deposit) { console.error('✗ depósito inválido'); process.exit(1); }
console.log(`    ✓ depósito recebido pelo keeper: ${formatEther(dtx.value)} ETH`);

// ───────────────────────────── 3) keeper abastece o attestor; ATTESTOR registra
const need = EVM_GAS_UNITS.register * gasPrice * 2n;
const attBal = await pub.getBalance({ address: attestor.address });
if (attBal < need) { console.log(`[3] keeper abastece o attestor (${formatEther(need - attBal)} ETH p/ o registro)…`); await wait(await keeperW.sendTransaction({ to: attestor.address, value: need - attBal, account: keeper, chain: sepolia })); }

const now = Number((await pub.getBlock()).timestamp);
const EXPIRES = now + 2400, DEADLINE = now + 2300;
const terms = {
  participants: [{ wallet: seller.address, role: 0 }, { wallet: buyer.address, role: 3 }],
  sellerAsset: evm.tusdt, sellerAmount: SELL, buyerAsset: NATIVE_ASSET_EVM as `0x${string}`, buyerAmount: BUY,
  platformFeeBps: 3, commissionBps: 0, discountBps: 0, slippageBps: 0,
  createdAt: BigInt(now), expiresAt: BigInt(EXPIRES), termsVersion: 2, nonce: BigInt(Date.now()), htlcHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
  commissionPm1: 0n, commissionPm2: 0n, dealType: 0, swapRouter: ('0x' + '0'.repeat(40)) as `0x${string}`, minAmountOut: 0n,
};
const termsHash = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'hashTermsV2', args: [terms] }) as `0x${string}`;
const tradeId = computeTradeIdEvm(evm.chainId, ESCROW, termsHash);
const att = async (wallet: string) => { const a = await signWalletAttestationEvm(evm.attestorKey as `0x${string}`, evm.chainId, ESCROW, wallet, now + 3600); return { validUntil: BigInt(a.validUntil), signature: a.signature as `0x${string}` }; };
console.log(`[3] ATTESTOR registra createTradeV2 (tradeId ${tradeId.slice(0, 18)}…) — criador = attestor, NÃO o PM1…`);
await wait(await attestorW.writeContract({ address: ESCROW, abi: ABI, functionName: 'createTradeV2', args: [terms, [await att(seller.address), await att(buyer.address)]], account: attestor, chain: sepolia }));
console.log('    ✓ registrada pelo attestor');

// ───────────────────────────── 4) signV2 das pernas + settle (keeper)
const sellerW = createWalletClient({ chain: sepolia, transport: http(evm.rpcUrl), account: seller });
const sign = async (acc: typeof seller, role: number) => acc.signTypedData({
  domain: { name: 'VerumOTC', version: '1', chainId: BigInt(evm.chainId), verifyingContract: ESCROW },
  types: { Approval: [{ name: 'tradeId', type: 'bytes32' }, { name: 'termsHash', type: 'bytes32' }, { name: 'role', type: 'uint8' }, { name: 'deadline', type: 'uint64' }] },
  primaryType: 'Approval', message: { tradeId, termsHash, role, deadline: BigInt(DEADLINE) },
});
console.log('[4] signV2 do Vendedor (approve+tUSDT) e do Comprador (value ETH)…');
await wait(await sellerW.writeContract({ address: evm.tusdt, abi: ERC20, functionName: 'approve', args: [ESCROW, SELL + FEE] }));
await wait(await sellerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(DEADLINE), await sign(seller, OnchainRole.SELLER)] }));
await wait(await buyerW.writeContract({ address: ESCROW, abi: ABI, functionName: 'signV2', args: [tradeId, BigInt(DEADLINE), await sign(buyer, OnchainRole.BUYER)], value: BUY }));

const sellerEth0 = await pub.getBalance({ address: seller.address });
console.log('    keeper liquida (settleV2)…');
await wait(await keeperW.writeContract({ address: ESCROW, abi: ABI, functionName: 'settleV2', args: [tradeId, '0x'] }));
const sellerEth1 = await pub.getBalance({ address: seller.address });
const buyerUsdt = await pub.readContract({ address: evm.tusdt, abi: ERC20, functionName: 'balanceOf', args: [buyer.address] }) as bigint;

// ───────────────────────────── 5) keeper devolve a sobra ao comprador
const spent = lifecycleGasUnits() * gasPrice;              // custo estimado do ciclo (sem margem)
const leftover = deposit > spent ? deposit - spent : 0n;
const buyerEthBeforeReturn = await pub.getBalance({ address: buyer.address });
console.log(`[5] keeper devolve a sobra ao comprador: ${formatEther(leftover)} ETH (depósito ${formatEther(deposit)} − ciclo ${formatEther(spent)})…`);
if (leftover > 0n) await wait(await keeperW.sendTransaction({ to: buyer.address, value: leftover, account: keeper, chain: sepolia }));
const buyerEthAfterReturn = await pub.getBalance({ address: buyer.address });

console.log('\n===== resultado =====');
const settledOk = sellerEth1 - sellerEth0 === BUY && buyerUsdt === SELL;
const returnedOk = buyerEthAfterReturn - buyerEthBeforeReturn === leftover;
console.log(`Liquidação: Vendedor +${formatEther(sellerEth1 - sellerEth0)} ETH (esp ${formatEther(BUY)}) · Comprador +${buyerUsdt} tUSDT (esp ${SELL}) → ${settledOk ? 'OK' : 'DIVERGE'}`);
console.log(`Registro: feito pelo ATTESTOR (não PM1) ✓`);
console.log(`Gás: comprador pré-pagou ${formatEther(deposit)} ETH, sobra devolvida ${formatEther(leftover)} ETH → custo líquido do ciclo p/ o comprador ${formatEther(deposit - leftover)} ETH`);
console.log(`Devolução da sobra creditada ao comprador: ${returnedOk ? 'OK' : 'DIVERGE'}`);
if (settledOk && returnedOk) console.log('\n✓ E2E PRÉ-PAGAMENTO DE GÁS CONFIRMADO (pagou → attestor registrou → liquidou → sobra devolvida)');
else { console.error('\n✗ divergência no fluxo'); process.exit(1); }
