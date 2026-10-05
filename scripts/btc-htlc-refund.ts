/**
 * Refund de um cofre HTLC P2WSH encalhado (trade expirada antes do settle): após o timelock de
 * CSV blocos, devolve o BTC ao endereço do VENDEDOR assinando com a chave keeper de refund.
 * O witness script é rebatido do htlcHash REGISTRADO NA SEPOLIA (getTradeV2 do escrow V2) —
 * nenhum estado local é necessário.
 *
 * Uso: npx tsx --env-file=.env scripts/btc-htlc-refund.ts <tradeId-sepolia> [payout-btc]
 *      payout padrão: endereço P2WPKH de BTC_SELLER_KEY do .env.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { loadConfig, bitcoinConfig, verumEvmConfig } from '../src/config.js';
import { htlcWitnessScript, p2wshAddress, p2wpkhAddress, outputScriptOf, buildHtlcSpend, EsploraClient, type HtlcUtxo, type BitcoinNet } from '../src/adapters/bitcoin.js';
import ABI from '../src/onchain/router/abi/verumOtcEscrowV2.js';

const [target, payoutArg] = process.argv.slice(2);
const isTradeId = /^0x[0-9a-f]{64}$/i.test(target ?? '');
const isVault = /^(tb1|bc1|bcrt1)[0-9a-z]{20,80}$/.test(target ?? '');
if (!isTradeId && !isVault) { console.error('Uso: npx tsx --env-file=.env scripts/btc-htlc-refund.ts <tradeId-sepolia | endereço-do-cofre> [payout-btc]\n(endereço do cofre usa .data/btc-swap-recovery.jsonl)'); process.exit(1); }
const config = loadConfig(process.env);
const btcCfg = bitcoinConfig(config); const evmCfg = verumEvmConfig(config);
if (!btcCfg || !evmCfg?.escrowV2) { console.error('exige BITCOIN_* + VERUM_EVM_V2_ESCROW_ADDRESS no .env'); process.exit(1); }
const net = btcCfg.network as BitcoinNet;
const esplora = new EsploraClient(btcCfg.esploraUrl);

let htlcHash: string;
if (isTradeId) {
  const pub = createPublicClient({ transport: http(evmCfg.rpcUrl) });
  const trade = await pub.readContract({ address: evmCfg.escrowV2, abi: ABI as never, functionName: 'getTradeV2', args: [target as `0x${string}`] }) as { htlcHash: `0x${string}` };
  htlcHash = trade.htlcHash.slice(2).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(htlcHash) || /^0+$/.test(htlcHash)) { console.error(`trade ${target} sem htlcHash no escrow V2`); process.exit(1); }
} else {
  // Cofre que nunca chegou à Sepolia: o htlcHash vem do arquivo de recuperação gravado ANTES do lock.
  const line = readFileSync('.data/btc-swap-recovery.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { vault: string; htlcHash: string }).reverse().find(r => r.vault === target);
  if (!line) { console.error(`cofre ${target} não encontrado em .data/btc-swap-recovery.jsonl`); process.exit(1); }
  htlcHash = line.htlcHash.toLowerCase();
}

const claimPub = secp256k1.getPublicKey(hexToBytes(btcCfg.claimKey.replace(/^0x/, '')), true);
const refundPriv = hexToBytes(btcCfg.refundKey.replace(/^0x/, ''));
const witnessScript = htlcWitnessScript(htlcHash, claimPub, secp256k1.getPublicKey(refundPriv, true), btcCfg.csvBlocks);
const vault = p2wshAddress(witnessScript, net);
const payout = payoutArg ?? (process.env.BTC_SELLER_KEY ? p2wpkhAddress(secp256k1.getPublicKey(hexToBytes(process.env.BTC_SELLER_KEY), true), net) : '');
if (!payout) { console.error('defina o payout (arg 2) ou BTC_SELLER_KEY no .env'); process.exit(1); }
console.log(`cofre:  ${vault}\npayout: ${payout}\nCSV:    ${btcCfg.csvBlocks} blocos`);

const [tip, utxosRaw] = await Promise.all([esplora.tipHeight(), esplora.utxos(vault)]);
const utxos: HtlcUtxo[] = utxosRaw.map(u => ({ txid: u.txid, vout: u.vout, valueSat: BigInt(u.value), confirmations: u.status.confirmed && u.status.block_height ? tip - u.status.block_height + 1 : 0 }));
if (!utxos.length) { console.log('cofre vazio — nada a reembolsar.'); process.exit(0); }
const immature = utxos.filter(u => u.confirmations < btcCfg.csvBlocks);
if (immature.length) { console.log(`timelock ainda não venceu: faltam ${btcCfg.csvBlocks - Math.min(...immature.map(u => u.confirmations))} blocos — rode de novo mais tarde.`); process.exit(0); }

const built = buildHtlcSpend({ utxos, witnessScript, payoutScript: outputScriptOf(payout, net), satPerVb: Math.max(btcCfg.feeFloorSatVb, 2), path: 'refund', keyPriv: refundPriv, csvBlocks: btcCfg.csvBlocks });
const txid = await esplora.broadcast(built.hex);
console.log(`REFUND transmitido: ${txid} (${utxos.reduce((s, u) => s + u.valueSat, 0n)} sats − fee ${built.feeSat})`);
console.log(`${btcCfg.esploraUrl.replace(/\/api\/?$/, '')}/tx/${txid}`);
void bytesToHex; // (mantém import utilitário para debug rápido)
