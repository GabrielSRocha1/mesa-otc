/**
 * Refund AUTÔNOMO dos cofres HTLC encalhados (deals que expiraram antes do settle): fica em loop
 * checando a maturidade do CSV (144 blocos) de cada cofre e transmite o refund assim que vencer,
 * devolvendo o BTC ao endereço do vendedor (BTC_SELLER_KEY). Sai quando todos estiverem vazios.
 *
 * Alvos: tradeIds no escrow informado (htlcHash lido do getTradeV2) e/ou cofres do arquivo
 * .data/btc-swap-recovery.jsonl (deals que nunca chegaram à Sepolia).
 *
 * Uso: nohup npx tsx --env-file=.env scripts/btc-htlc-refund-all.ts > refunds.log &
 */
import { readFileSync, existsSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { loadConfig, bitcoinConfig, verumEvmConfig } from '../src/config.js';
import { htlcWitnessScript, p2wshAddress, p2wpkhAddress, outputScriptOf, buildHtlcSpend, EsploraClient, type HtlcUtxo, type BitcoinNet } from '../src/adapters/bitcoin.js';
import ABI from '../src/onchain/router/abi/verumOtcEscrowV2.js';

const config = loadConfig(process.env);
const btcCfg = bitcoinConfig(config); const evmCfg = verumEvmConfig(config);
if (!btcCfg || !evmCfg || !process.env.BTC_SELLER_KEY) { console.error('exige BITCOIN_* + VERUM_EVM_* + BTC_SELLER_KEY no .env'); process.exit(1); }
const net = btcCfg.network as BitcoinNet;
const esplora = new EsploraClient(btcCfg.esploraUrl);
const pub = createPublicClient({ transport: http(evmCfg.rpcUrl) });
const claimPub = secp256k1.getPublicKey(hexToBytes(btcCfg.claimKey.replace(/^0x/, '')), true);
const refundPriv = hexToBytes(btcCfg.refundKey.replace(/^0x/, ''));
const refundPub = secp256k1.getPublicKey(refundPriv, true);
const payout = p2wpkhAddress(secp256k1.getPublicKey(hexToBytes(process.env.BTC_SELLER_KEY), true), net);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Cofres das tentativas que REGISTRARAM trade na Sepolia (o htlcHash mora no escrow da época). */
const TRADE_TARGETS: { label: string; escrow: `0x${string}`; tradeId: `0x${string}` }[] = [
  { label: 't2', escrow: '0x6362B1aFb1279214F58Fe8769049F078BACfC38F', tradeId: '0xd417e580998808fd4dd8827861afe5231931292eebd98dc5a093c9c5963fef54' },
  { label: 't3', escrow: '0x6362B1aFb1279214F58Fe8769049F078BACfC38F', tradeId: '0xde359936e19a7b306914b2bdff725d81712019b9249180c1a11340e267024abc' },
];

/** ABI LEGADO do getTradeV2 (escrow 0x6362…, pré-comissão): o struct antigo não decoda com o ABI novo. */
const LEGACY_GET_TRADE_ABI = [{
  type: 'function', name: 'getTradeV2', stateMutability: 'view', inputs: [{ name: 'tradeId', type: 'bytes32' }],
  outputs: [{ type: 'tuple', components: [
    { name: 'termsHash', type: 'bytes32' }, { name: 'state', type: 'uint8' }, { name: 'nextIdx', type: 'uint8' },
    { name: 'sellerExternal', type: 'bool' }, { name: 'sellerDeposited', type: 'bool' }, { name: 'buyerDeposited', type: 'bool' },
    { name: 'feeCollected', type: 'bool' }, { name: 'feeAmount', type: 'uint256' }, { name: 'settledAt', type: 'uint64' }, { name: 'expiredAt', type: 'uint64' },
    { name: 'seller', type: 'address' }, { name: 'paymaster01', type: 'address' }, { name: 'paymaster02', type: 'address' }, { name: 'buyer', type: 'address' },
    { name: 'sellerAsset', type: 'address' }, { name: 'sellerAmount', type: 'uint256' }, { name: 'buyerAsset', type: 'address' }, { name: 'buyerAmount', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' }, { name: 'htlcHash', type: 'bytes32' }, { name: 'revealedPreimage', type: 'bytes' },
  ] }],
}] as const;

async function collectTargets(): Promise<{ label: string; htlcHash: string }[]> {
  const out: { label: string; htlcHash: string }[] = [];
  for (const t of TRADE_TARGETS) {
    try {
      const trade = await pub.readContract({ address: t.escrow, abi: LEGACY_GET_TRADE_ABI, functionName: 'getTradeV2', args: [t.tradeId] }) as { htlcHash: `0x${string}` };
      const h = trade.htlcHash.slice(2).toLowerCase();
      if (/^[0-9a-f]{64}$/.test(h) && !/^0+$/.test(h)) out.push({ label: t.label, htlcHash: h });
      else console.log(`[${t.label}] sem htlcHash no escrow ${t.escrow} — pulando`);
    } catch (e) { console.log(`[${t.label}] falha ao ler o escrow: ${(e as Error).message.split('\n')[0]}`); }
  }
  if (existsSync('.data/btc-swap-recovery.jsonl')) {
    const seen = new Set(out.map(o => o.htlcHash));
    for (const line of readFileSync('.data/btc-swap-recovery.jsonl', 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { dealId: string; htlcHash: string; vault: string };
      if (!seen.has(r.htlcHash.toLowerCase())) { seen.add(r.htlcHash.toLowerCase()); out.push({ label: r.dealId, htlcHash: r.htlcHash.toLowerCase() }); }
    }
  }
  return out;
}

const targets = await collectTargets();
console.log(`REFUND-ALL: ${targets.length} cofres · payout ${payout} · CSV ${btcCfg.csvBlocks} blocos`);
const pending = new Map(targets.map(t => {
  const script = htlcWitnessScript(t.htlcHash, claimPub, refundPub, btcCfg.csvBlocks);
  return [t.label, { script, vault: p2wshAddress(script, net) }];
}));
for (const [label, v] of pending) console.log(`  [${label}] ${v.vault}`);

while (pending.size > 0) {
  const tip = await esplora.tipHeight().catch(() => null);
  for (const [label, v] of [...pending]) {
    try {
      const utxosRaw = await esplora.utxos(v.vault);
      if (!utxosRaw.length) {
        // Vazio: refundado por outra via, gasto pelo claim, ou nunca financiado — nada a fazer.
        console.log(`[${label}] cofre vazio — concluído`); pending.delete(label); continue;
      }
      const utxos: HtlcUtxo[] = utxosRaw.map(u => ({ txid: u.txid, vout: u.vout, valueSat: BigInt(u.value), confirmations: u.status.confirmed && u.status.block_height && tip ? tip - u.status.block_height + 1 : 0 }));
      const minConf = Math.min(...utxos.map(u => u.confirmations));
      if (minConf < btcCfg.csvBlocks) { console.log(`[${label}] imaturo: ${minConf}/${btcCfg.csvBlocks} confirmações`); continue; }
      const built = buildHtlcSpend({ utxos, witnessScript: v.script, payoutScript: outputScriptOf(payout, net), satPerVb: Math.max(btcCfg.feeFloorSatVb, 2), path: 'refund', keyPriv: refundPriv, csvBlocks: btcCfg.csvBlocks });
      const txid = await esplora.broadcast(built.hex);
      console.log(`[${label}] REFUND transmitido: ${txid} (${utxos.reduce((s, u) => s + u.valueSat, 0n)} sats − fee ${built.feeSat})`);
      pending.delete(label);
    } catch (e) { console.log(`[${label}] erro (tentarei de novo): ${(e as Error).message.split('\n')[0]}`); }
  }
  if (pending.size === 0) break;
  await sleep(20 * 60_000); // maturidade avança por BLOCO — 20 min entre varreduras é suficiente
}
console.log(`CONCLUIDO: todos os cofres resolvidos · saldo do vendedor: ${await esplora.addressSats(payout).catch(() => '?')} sats`);
