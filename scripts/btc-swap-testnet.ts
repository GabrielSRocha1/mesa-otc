/**
 * Runner guiado do swap atômico BTC nativo (testnet4) ↔ tUSDT (escrow V2 na Sepolia).
 * Sobe o app EM PROCESSO com o seu .env real e dirige o fluxo inteiro, imprimindo o que fazer:
 *
 *   1. imprime o endereço BTC do VENDEDOR → você manda tBTC do faucet p/ ele e o script espera;
 *   2. cria a deal BTC→tUSDT (vendedor BTC + comprador/PM1 EVM dev), registra na Sepolia
 *      (createTradeV2 real) e deriva o cofre P2WSH — o fund do vendedor responde
 *      FUNDING_REQUIRED com o endereço exato, e o script CONSTRÓI e transmite o lock;
 *   3. coleta as assinaturas na ordem, liquida: settleV2 revela a preimage na Sepolia e o
 *      adapter Bitcoin dá o claim na testnet4 — BTC no comprador, tUSDT no vendedor.
 *
 * Uso:  npx tsx --env-file=.env scripts/btc-swap-testnet.ts
 * Pré-requisitos no .env: grupo BITCOIN_* (testnet) + VERUM_EVM_* + VERUM_EVM_V2_ESCROW_ADDRESS.
 * Knobs: SWAP_SATS (padrão 20000). Chaves BTC do cenário são geradas e SALVAS no .env na 1ª vez
 * (BTC_SELLER_KEY/BTC_BUYER_KEY) para o endereço do faucet ser estável entre execuções.
 * ATENÇÃO: a janela do escrow é de 40 min a partir do "open" — o lock precisa confirmar dentro
 * dela (testnet4 tem blocos irregulares). Se expirar: tUSDT reembolsa na hora; BTC volta pelo
 * timelock de 144 blocos.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { loadConfig, bitcoinConfig, verumEvmConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { bitcoinMessageHash } from '../src/engines/signature.js';
import { SIGNING_ORDER, type CanonicalAsset, type Role } from '../src/domain/types.js';
import { p2wpkhAddress, p2wshAddress, htlcWitnessScript, bip143Sighash, varint, EsploraClient, type HtlcUtxo, type BitcoinNet } from '../src/adapters/bitcoin.js';
import type { VerumEvmV2Adapter } from '../src/adapters/verum/evmV2.js';

const log = (m: string): void => console.log(`\n▸ ${m}`);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const u32le = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

/** Chave do cenário persistida no .env (endereço do faucet estável entre execuções). */
function envKey(name: string): Uint8Array {
  const cur = process.env[name];
  if (cur && /^[0-9a-f]{64}$/i.test(cur)) return hexToBytes(cur.toLowerCase());
  const k = randomBytes(32);
  appendFileSync('.env', `\n${name}=${k.toString('hex')}`);
  console.log(`  (gerada e salva no .env: ${name})`);
  return Uint8Array.from(k);
}

const config = loadConfig(process.env);
const btcCfg = bitcoinConfig(config);
const evmCfg = verumEvmConfig(config);
if (!btcCfg || !evmCfg?.escrowV2) {
  console.error('Configure no .env: grupo BITCOIN_* (Esplora testnet) + VERUM_EVM_* + VERUM_EVM_V2_ESCROW_ADDRESS.');
  process.exit(1);
}
const SATS = BigInt(process.env.SWAP_SATS ?? '20000');
const net = btcCfg.network as BitcoinNet;
const esplora = new EsploraClient(btcCfg.esploraUrl);

const sellerBtcPriv = envKey('BTC_SELLER_KEY');
const buyerBtcPriv = envKey('BTC_BUYER_KEY');
const sellerBtcPub = secp256k1.getPublicKey(sellerBtcPriv, true);
const sellerBtcAddr = p2wpkhAddress(sellerBtcPub, net);
const buyerBtcAddr = p2wpkhAddress(secp256k1.getPublicKey(buyerBtcPriv, true), net);
const signBip137 = (m: string): string => {
  const s = secp256k1.sign(bitcoinMessageHash(m), sellerBtcPriv, { prehash: false, format: 'recovered' });
  return Buffer.from(new Uint8Array([27 + (s[0] as number) + 4, ...s.slice(1)])).toString('base64');
};

/** Lock "da Verum Wallet": gasta UTXOs do vendedor e tranca `sats` no cofre P2WSH (BIP-143 real). */
function buildLockTx(utxos: HtlcUtxo[], vaultScriptHash: Uint8Array, sats: bigint, feeSat: bigint): string {
  const total = utxos.reduce((s, u) => s + u.valueSat, 0n);
  const change = total - sats - feeSat;
  if (change < 0n) throw new Error(`saldo insuficiente: tem ${total}, precisa ${sats + feeSat}`);
  const h160 = ripemd160(sha256(sellerBtcPub));
  const outs: Uint8Array[] = [u64le(sats), varint(34), Uint8Array.of(0x00, 0x20), vaultScriptHash];
  if (change >= 546n) outs.push(u64le(change), varint(22), Uint8Array.of(0x00, 0x14), h160);
  const outputsBody = concatBytes(...outs); // SEM varint de contagem: o hashOutputs do BIP-143 não o inclui
  const nOut = varint(change >= 546n ? 2 : 1);
  const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac));
  const ins = concatBytes(varint(utxos.length), ...utxos.map(u => concatBytes(hexToBytes(u.txid).reverse(), u32le(u.vout), varint(0), u32le(0xfffffffd))));
  const wits = utxos.map((_, i) => {
    const sighash = bip143Sighash({ utxos, witnessScript: scriptCode }, i, 0xfffffffd, outputsBody);
    const sig = concatBytes(secp256k1.sign(sighash, sellerBtcPriv, { prehash: false, format: 'der' }), Uint8Array.of(0x01));
    return concatBytes(varint(2), varint(sig.length), sig, varint(sellerBtcPub.length), sellerBtcPub);
  });
  return bytesToHex(concatBytes(u32le(2), Uint8Array.of(0x00, 0x01), ins, nOut, outputsBody, concatBytes(...wits), u32le(0)));
}

log(`Subindo o app (escrow V2 ${evmCfg.escrowV2} · Bitcoin ${net} via ${btcCfg.esploraUrl})…`);
const app = await createApp(config, {
  autoSettle: false,
  btcAddressOf: async (_d, role) => (role === 'BUYER' ? buyerBtcAddr : null),       // claim BTC → comprador
  evmAddressOf: async (_d, role) => (role === 'SELLER' ? sellerEvm.address : null), // tUSDT → vendedor
});
const keyring = app.verumEvmKeyring;
if (!keyring) { console.error('Keyring dev EVM indisponível (OTC_ENV=prod?).'); process.exit(1); }
const sellerEvm = keyring.accountFor('swap-seller');
const buyerEvm = keyring.accountFor('swap-buyer');
const pm1Evm = keyring.accountFor('swap-pm1');

// ---- 1. faucet → endereço do vendedor ----
log(`VENDEDOR (BTC ${net}): ${sellerBtcAddr}`);
console.log(`  Mande ≥ ${SATS + 3000n} sats do faucet (https://mempool.space/testnet4/faucet) para o endereço acima.`);
for (;;) {
  const sats = await esplora.addressSats(sellerBtcAddr).catch(() => 0n);
  if (sats >= SATS + 3000n) { log(`Saldo do vendedor confirmado: ${sats} sats.`); break; }
  console.log(`  aguardando faucet… (saldo atual: ${sats} sats)`); await sleep(20_000);
}

// ---- 2. tUSDT e gás do comprador (mint dev é permissionless; keeper paga o gás) ----
const evmV2 = app.adapters.require('ethereum') as VerumEvmV2Adapter;
const tusdtAsset = { network: 'ethereum' as const, chainId: String(evmCfg.chainId), contractOrMint: evmCfg.tusdt };
const buyerUsdt = await evmV2.getBalance(buyerEvm.address, { ...tusdtAsset, code: 'USDT', decimals: 6, tokenStandard: 'ERC-20', assetId: '' } as unknown as CanonicalAsset);
if (buyerUsdt < 1_000_000_000n) { log('Mintando 10.000 tUSDT de teste para o comprador…'); await evmV2.mintToken(evmCfg.tusdt, buyerEvm.address, 10_000_000_000n); }

// ---- 3. cria a deal BTC → tUSDT ----
log('Criando a deal BTC → tUSDT…');
const participants = [
  { role: 'SELLER' as Role, network: 'bitcoin' as const, chainId: net, address: sellerBtcAddr },
  { role: 'PAYMASTER_1' as Role, network: 'ethereum' as const, chainId: String(evmCfg.chainId), address: pm1Evm.address },
  { role: 'BUYER' as Role, network: 'ethereum' as const, chainId: String(evmCfg.chainId), address: buyerEvm.address },
];
let deal = await app.deals.create({
  assetIn: { network: 'bitcoin', chainId: net, contractOrMint: null },
  assetOut: { network: 'ethereum', chainId: String(evmCfg.chainId), contractOrMint: evmCfg.tusdt },
  // 24h de validade da deal: a testnet4 pode levar HORAS para incluir o lock; as janelas curtas
  // (40 min on-chain + 5 min por turno) continuam começando só no open, depois do lock confirmado.
  amountInBase: SATS.toString(), discountBps: 0, maxSlippageBps: 100, maxPriceDriftBps: 500, expiresInSec: 24 * 3600, participants,
}, sellerBtcAddr);
for (const p of participants) if (p.role !== 'SELLER') deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address);
deal = await app.deals.get(deal.id);
log(`Deal ${deal.id} · estado ${deal.state} · rota ${deal.terms?.route.routeId ?? '—'} · htlcHash ${deal.terms?.route.htlcHash?.slice(0, 16)}…`);

// ---- 4. LOCK ANTES DO OPEN: o cofre P2WSH é derivável dos termos congelados (htlcHash) +
// chaves keeper do .env — trancamos e CONFIRMAMOS o BTC antes de abrir, porque as janelas da
// mesa (40 min da trade + 5 min POR TURNO de assinatura) começam no open e a testnet4 pode
// levar dezenas de minutos para fechar um bloco.
const htlcHash = deal.terms!.route.htlcHash as string;
const witnessScript = htlcWitnessScript(htlcHash, secp256k1.getPublicKey(hexToBytes(btcCfg.claimKey.replace(/^0x/, '')), true), secp256k1.getPublicKey(hexToBytes(btcCfg.refundKey.replace(/^0x/, '')), true), btcCfg.csvBlocks);
const vault = p2wshAddress(witnessScript, net);
log(`COFRE HTLC (P2WSH ${net}): ${vault}`);
console.log(`  htlcHash completo: ${htlcHash}`);
// Recuperação ANTES do lock: se o processo morrer, o refund pós-timelock reconstrói o script daqui.
mkdirSync('.data', { recursive: true });
appendFileSync('.data/btc-swap-recovery.jsonl', JSON.stringify({ at: new Date().toISOString(), dealId: deal.id, net, vault, htlcHash, witnessScript: bytesToHex(witnessScript), csvBlocks: btcCfg.csvBlocks }) + '\n');
const alreadyLocked = (await esplora.utxos(vault).catch(() => [])).reduce((s, u) => s + BigInt(u.value), 0n);
if (alreadyLocked < SATS) {
  const utxos: HtlcUtxo[] = (await esplora.utxos(sellerBtcAddr)).map(u => ({ txid: u.txid, vout: u.vout, valueSat: BigInt(u.value), confirmations: 1 }));
  const lockTxid = await esplora.broadcast(buildLockTx(utxos, sha256(witnessScript), SATS, 1500n));
  log(`Lock transmitido: ${lockTxid}`);
  console.log(`  acompanhe: ${btcCfg.esploraUrl.replace(/\/api\/?$/, '')}/tx/${lockTxid}`);
  log('Aguardando a confirmação do lock ANTES de abrir a trade (as janelas só começam depois)…');
  for (;;) {
    const st = await esplora.tx(lockTxid).catch(() => null);
    if (st?.status.confirmed) { log('Lock confirmado on-chain.'); break; }
    console.log('  …aguardando bloco na testnet4'); await sleep(30_000);
  }
} else log(`Cofre já tem ${alreadyLocked} sats confirmados — reaproveitando o lock.`);

// ---- 5. open (createTradeV2 na Sepolia) + funding das duas pernas — agora tudo em ritmo Sepolia ----
log('Abrindo a deal (createTradeV2 na Sepolia — ~30-90s de confirmações)…');
await app.deals.open(deal.id, sellerBtcAddr);
deal = await app.deals.get(deal.id);
const tradeId = (deal.onChain?.ethereum?.meta as { tradeId?: string } | undefined)?.tradeId;
console.log(`  tradeId Sepolia: ${tradeId} · https://sepolia.etherscan.io/address/${evmCfg.escrowV2}`);

log('Financiando a perna do comprador (approve tUSDT)…');
await app.deals.fund(deal.id, 'BUYER', buyerEvm.address);
log('Financiando a perna do vendedor (lock já confirmado — detecção imediata)…');
await app.deals.fund(deal.id, 'SELLER', sellerBtcAddr);
log('Perna BTC financiada (lock detectado on-chain).');

// ---- 6. assinaturas na ordem Vendedor → PM1 → Comprador ----
for (const role of SIGNING_ORDER) {
  const p = participants.find(x => x.role === role);
  if (!p) continue;
  log(`Assinando como ${role}…`);
  const env = await app.deals.envelope(deal.id, role, p.address);
  const signature = role === 'SELLER'
    ? signBip137(env.message)
    : await (role === 'BUYER' ? buyerEvm : pm1Evm).signTypedData({ domain: env.typedData!.domain, types: env.typedData!.types, primaryType: 'DealApproval', message: env.typedData!.message } as unknown as Parameters<typeof buyerEvm.signTypedData>[0]);
  await app.deals.submitSignature(deal.id, { role, signer: p.address, scheme: env.scheme, signature, nonce: env.payload.nonce }, p.address);
}
deal = await app.deals.get(deal.id);
log(`Assinaturas completas · estado ${deal.state}`);

// ---- 7. liquidação: settleV2 revela a preimage na Sepolia → claim do BTC na testnet4 ----
log('Liquidando (settleV2 na Sepolia + claim BTC)…');
const rec = await app.settlement.settle(deal.id);
const btcLegTx = rec.legs.find(l => deal.terms?.legs.find(t => t.index === l.index)?.escrowChain === 'bitcoin')?.txRef;
const evmLegTx = rec.legs.find(l => deal.terms?.legs.find(t => t.index === l.index)?.escrowChain === 'ethereum')?.txRef;
const preimage = await evmV2.revealedPreimage(deal.id);
log(`RESULTADO: liquidação ${rec.status} · deal ${(await app.deals.get(deal.id)).state}`);
console.log(`  preimage revelada no contrato: ${preimage}`);
console.log(`  settleV2 Sepolia: https://sepolia.etherscan.io/tx/${evmLegTx}`);
console.log(`  claim BTC:        ${btcCfg.esploraUrl.replace(/\/api\/?$/, '')}/tx/${btcLegTx}`);
console.log(`  BTC do comprador (${buyerBtcAddr}): ${await esplora.addressSats(buyerBtcAddr)} sats`);
console.log(`  tUSDT do vendedor (${sellerEvm.address}): ${await evmV2.getBalance(sellerEvm.address, { ...tusdtAsset, code: 'USDT', decimals: 6, tokenStandard: 'ERC-20', assetId: '' } as unknown as CanonicalAsset)}`);
await app.close();
process.exit(0);
