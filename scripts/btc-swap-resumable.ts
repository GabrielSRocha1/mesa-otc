/**
 * Swap atômico BTC(testnet4) ↔ tUSDT(Sepolia) em DUAS FASES curtas — resiliente ao limite de
 * processo do ambiente (a testnet4 pode levar dezenas de min para fechar um bloco).
 *
 *   FASE 1  `lock`   → gera/reusa a preimage (SALVA em .data/btc-swap-active.json), deriva o cofre
 *                      P2WSH e transmite o lock. Sai em segundos (não espera bloco).
 *   (espera)         → confirmação do bloco é verificada POR FORA (poll leve de curl).
 *   FASE 2  `settle` → recria a deal com a MESMA preimage (htlcPreimageHex), abre (createTradeV2),
 *                      financia as duas pernas, assina na ordem e liquida (settleV2 + claim BTC).
 *
 * Uso: npx tsx --env-file=.env scripts/btc-swap-resumable.ts lock
 *      npx tsx --env-file=.env scripts/btc-swap-resumable.ts settle
 */
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

const PHASE = (process.argv[2] ?? 'lock').toLowerCase();
const STATE_FILE = '.data/btc-swap-active.json';
const log = (m: string): void => console.log(`\n▸ ${m}`);
const u32le = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

function envKey(name: string): Uint8Array {
  const cur = process.env[name];
  if (cur && /^[0-9a-f]{64}$/i.test(cur)) return hexToBytes(cur.toLowerCase());
  const k = randomBytes(32);
  appendFileSync('.env', `\n${name}=${k.toString('hex')}\n`);
  return Uint8Array.from(k);
}

const config = loadConfig(process.env);
const btcCfg = bitcoinConfig(config);
const evmCfg = verumEvmConfig(config);
if (!btcCfg || !evmCfg?.escrowV2) { console.error('Configure BITCOIN_* + VERUM_EVM_* + VERUM_EVM_V2_ESCROW_ADDRESS no .env.'); process.exit(1); }
const SATS = BigInt(process.env.SWAP_SATS ?? '20000');
const net = btcCfg.network as BitcoinNet;
const esplora = new EsploraClient(btcCfg.esploraUrl);
const sellerBtcPriv = envKey('BTC_SELLER_KEY');
const sellerBtcPub = secp256k1.getPublicKey(sellerBtcPriv, true);
const sellerBtcAddr = p2wpkhAddress(sellerBtcPub, net);
const buyerBtcAddr = p2wpkhAddress(secp256k1.getPublicKey(envKey('BTC_BUYER_KEY'), true), net);
const claimPub = secp256k1.getPublicKey(hexToBytes(btcCfg.claimKey.replace(/^0x/, '')), true);
const refundPub = secp256k1.getPublicKey(hexToBytes(btcCfg.refundKey.replace(/^0x/, '')), true);
const signBip137 = (m: string): string => { const s = secp256k1.sign(bitcoinMessageHash(m), sellerBtcPriv, { prehash: false, format: 'recovered' }); return Buffer.from(new Uint8Array([27 + (s[0] as number) + 4, ...s.slice(1)])).toString('base64'); };

function buildLockTx(utxos: HtlcUtxo[], vaultScriptHash: Uint8Array, sats: bigint, feeSat: bigint): string {
  const total = utxos.reduce((s, u) => s + u.valueSat, 0n);
  const change = total - sats - feeSat;
  if (change < 0n) throw new Error(`saldo insuficiente: tem ${total}, precisa ${sats + feeSat}`);
  const h160 = ripemd160(sha256(sellerBtcPub));
  const outs: Uint8Array[] = [u64le(sats), varint(34), Uint8Array.of(0x00, 0x20), vaultScriptHash];
  if (change >= 546n) outs.push(u64le(change), varint(22), Uint8Array.of(0x00, 0x14), h160);
  const outputsBody = concatBytes(...outs);
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

interface SwapState { preimage: string; htlcHash: string; vault: string; sats: string; lockTxid?: string; createdAt: string }
const loadState = (): SwapState | null => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SwapState; } catch { return null; } };
const saveState = (s: SwapState): void => { mkdirSync('.data', { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };

// ───────────────────────── FASE 1: LOCK ─────────────────────────
if (PHASE === 'lock') {
  let st = loadState();
  const preimage = st?.preimage ?? bytesToHex(randomBytes(32));
  const htlcHash = bytesToHex(sha256(hexToBytes(preimage)));
  const witnessScript = htlcWitnessScript(htlcHash, claimPub, refundPub, btcCfg.csvBlocks);
  const vault = p2wshAddress(witnessScript, net);
  log(`cenário · vendedor ${sellerBtcAddr} · cofre ${vault}`);
  console.log(`  htlcHash=${htlcHash}`);
  st = { preimage, htlcHash, vault, sats: SATS.toString(), lockTxid: st?.lockTxid, createdAt: st?.createdAt ?? new Date().toISOString() };
  saveState(st);
  const locked = (await esplora.utxos(vault).catch(() => [])).reduce((s, u) => s + BigInt(u.value), 0n);
  if (locked >= SATS) { log(`cofre já tem ${locked} sats — lock pronto. Rode a FASE settle quando confirmar.`); process.exit(0); }
  const sellerSats = await esplora.addressSats(sellerBtcAddr).catch(() => 0n);
  if (sellerSats < SATS + 3000n) { console.error(`  vendedor sem saldo (${sellerSats} sats). Faucet: https://mempool.space/testnet4/faucet → ${sellerBtcAddr}`); process.exit(1); }
  const utxos: HtlcUtxo[] = (await esplora.utxos(sellerBtcAddr)).map(u => ({ txid: u.txid, vout: u.vout, valueSat: BigInt(u.value), confirmations: 1 }));
  const lockTxid = await esplora.broadcast(buildLockTx(utxos, sha256(witnessScript), SATS, 1500n));
  st.lockTxid = lockTxid; saveState(st);
  log(`LOCK transmitido: ${lockTxid}`);
  console.log(`  acompanhe: ${btcCfg.esploraUrl.replace(/\/api\/?$/, '')}/tx/${lockTxid}`);
  console.log(`  quando confirmar (1 bloco), rode: npx tsx --env-file=.env scripts/btc-swap-resumable.ts settle`);
  process.exit(0);
}

// ───────────────────────── FASE 2: SETTLE ─────────────────────────
if (PHASE === 'settle') {
  const st = loadState();
  if (!st) { console.error('sem estado ativo (.data/btc-swap-active.json). Rode a FASE lock primeiro.'); process.exit(1); }
  // Confirmação do lock (1 bloco basta — BITCOIN_CONFIRMATIONS=1).
  const txStatus = st.lockTxid ? await esplora.tx(st.lockTxid).catch(() => null) : null;
  const confirmed = (await esplora.utxos(st.vault).catch(() => [])).reduce((s, u) => s + BigInt(u.value), 0n);
  if (!txStatus?.status.confirmed) { log(`lock ainda NÃO confirmado (cofre ${st.vault} tem ${confirmed} sats vistos). Aguarde o bloco e rode settle de novo.`); process.exit(2); }
  log(`lock confirmado · cofre ${st.vault} · ${confirmed} sats`);

  log(`Subindo o app (escrow V2 ${evmCfg.escrowV2} · Bitcoin ${net})…`);
  const app = await createApp(config, {
    autoSettle: false,
    htlcPreimageHex: st.preimage, // recria a deal com o MESMO htlcHash do lock confirmado
    btcAddressOf: async (_d, role) => (role === 'BUYER' ? buyerBtcAddr : null),
    evmAddressOf: async (_d, role) => (role === 'SELLER' ? sellerEvm.address : null),
  });
  const keyring = app.verumEvmKeyring;
  if (!keyring) { console.error('Keyring dev EVM indisponível (OTC_ENV=prod?).'); process.exit(1); }
  const sellerEvm = keyring.accountFor('swap-seller');
  const buyerEvm = keyring.accountFor('swap-buyer');
  const pm1Evm = keyring.accountFor('swap-pm1');

  const evmV2 = app.adapters.require('ethereum') as VerumEvmV2Adapter;
  const tusdtAsset = { network: 'ethereum' as const, chainId: String(evmCfg.chainId), contractOrMint: evmCfg.tusdt };
  const usdtOf = (a: string) => evmV2.getBalance(a, { ...tusdtAsset, code: 'USDT', decimals: 6, tokenStandard: 'ERC-20', assetId: '' } as unknown as CanonicalAsset);
  if ((await usdtOf(buyerEvm.address)) < 1_000_000_000n) { log('Mintando 10.000 tUSDT para o comprador…'); await evmV2.mintToken(evmCfg.tusdt, buyerEvm.address, 10_000_000_000n); }

  log('Criando a deal BTC → tUSDT (preimage fixa = lock confirmado)…');
  const participants = [
    { role: 'SELLER' as Role, network: 'bitcoin' as const, chainId: net, address: sellerBtcAddr },
    { role: 'PAYMASTER_1' as Role, network: 'ethereum' as const, chainId: String(evmCfg.chainId), address: pm1Evm.address },
    { role: 'BUYER' as Role, network: 'ethereum' as const, chainId: String(evmCfg.chainId), address: buyerEvm.address },
  ];
  let deal = await app.deals.create({
    assetIn: { network: 'bitcoin', chainId: net, contractOrMint: null },
    assetOut: { network: 'ethereum', chainId: String(evmCfg.chainId), contractOrMint: evmCfg.tusdt },
    amountInBase: SATS.toString(), discountBps: 0, maxSlippageBps: 100, maxPriceDriftBps: 500, expiresInSec: 24 * 3600, participants,
  }, sellerBtcAddr);
  for (const p of participants) if (p.role !== 'SELLER') deal = await app.deals.connectWallet(deal.id, p.role, p.address, p.address);
  deal = await app.deals.get(deal.id);
  const dealHtlc = deal.terms!.route.htlcHash as string;
  if (dealHtlc !== st.htlcHash) { console.error(`htlcHash divergente: deal ${dealHtlc} ≠ lock ${st.htlcHash}. Abortando (não bate com o cofre).`); process.exit(1); }
  log(`Deal ${deal.id} · htlcHash confere com o cofre ✓`);

  log('Abrindo a deal (createTradeV2 na Sepolia)…');
  await app.deals.open(deal.id, sellerBtcAddr);
  deal = await app.deals.get(deal.id);
  const tradeId = (deal.onChain?.ethereum?.meta as { tradeId?: string } | undefined)?.tradeId;
  console.log(`  tradeId Sepolia: ${tradeId}`);
  log('Financiando comprador (approve+deposit tUSDT)…'); await app.deals.fund(deal.id, 'BUYER', buyerEvm.address);
  log('Financiando vendedor (lock já confirmado)…'); await app.deals.fund(deal.id, 'SELLER', sellerBtcAddr);

  for (const role of SIGNING_ORDER) {
    const p = participants.find(x => x.role === role); if (!p) continue;
    log(`Assinando como ${role}…`);
    const env = await app.deals.envelope(deal.id, role, p.address);
    const signature = role === 'SELLER' ? signBip137(env.message)
      : await (role === 'BUYER' ? buyerEvm : pm1Evm).signTypedData({ domain: env.typedData!.domain, types: env.typedData!.types, primaryType: 'DealApproval', message: env.typedData!.message } as unknown as Parameters<typeof buyerEvm.signTypedData>[0]);
    await app.deals.submitSignature(deal.id, { role, signer: p.address, scheme: env.scheme, signature, nonce: env.payload.nonce }, p.address);
  }
  deal = await app.deals.get(deal.id);
  log(`Assinaturas completas · estado ${deal.state}`);

  log('Liquidando (settleV2 na Sepolia + claim BTC na testnet4)…');
  const rec = await app.settlement.settle(deal.id);
  const btcLegTx = rec.legs.find(l => deal.terms?.legs.find(t => t.index === l.index)?.escrowChain === 'bitcoin')?.txRef;
  const evmLegTx = rec.legs.find(l => deal.terms?.legs.find(t => t.index === l.index)?.escrowChain === 'ethereum')?.txRef;
  const preimageOnChain = await evmV2.revealedPreimage(deal.id).catch(() => '—');
  saveState({ ...st, createdAt: st.createdAt }); // mantém histórico
  log(`RESULTADO: liquidação ${rec.status} · deal ${(await app.deals.get(deal.id)).state}`);
  console.log(`  preimage revelada no contrato: ${preimageOnChain}`);
  console.log(`  settleV2 Sepolia: https://sepolia.etherscan.io/tx/${evmLegTx}`);
  console.log(`  claim BTC:        ${btcCfg.esploraUrl.replace(/\/api\/?$/, '')}/tx/${btcLegTx}`);
  console.log(`  BTC do comprador (${buyerBtcAddr}): ${await esplora.addressSats(buyerBtcAddr)} sats`);
  console.log(`  tUSDT do vendedor (${sellerEvm.address}): ${await usdtOf(sellerEvm.address)}`);
  await app.close();
  process.exit(0);
}

console.error(`fase desconhecida: ${PHASE} (use 'lock' ou 'settle')`);
process.exit(1);
