/**
 * E2E — swap atômico BTC nativo ↔ USDC(Solana) com o BitcoinChainAdapter REAL apontado para um
 * Esplora regtest (in-process, sem bitcoind): BITCOIN_* nas envs, carteira BTC do vendedor
 * ("Verum Wallet") construindo e ASSINANDO a transação de lock no cofre P2WSH, motor completo
 * (fund → assinaturas → settle): a perna de contrato revela a preimage, o adapter monta o claim
 * REAL, transmite, e a preimage é extraída do witness observado na "rede".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { makeApp, prepareDeal, solWallet, signAs, ASSETS, type Parts, type Wallet } from './helpers.js';
import { SIGNING_ORDER, type Deal } from '../src/domain/types.js';
import { bitcoinMessageHash } from '../src/engines/signature.js';
import { htlcWitnessScript, p2wshAddress, p2wpkhAddress, bip143Sighash, varint, type HtlcUtxo } from '../src/adapters/bitcoin.js';
import { EsploraRegtest } from './esploraRegtest.js';

const code = (p: Promise<unknown>) => p.then(() => null, e => (e as { code?: string }).code ?? 'ERRO');
const u32le = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

// ---- chaves do cenário (determinísticas) ----
const CLAIM_KEY = '11'.repeat(32); const REFUND_KEY = '22'.repeat(32);
const claimPub = secp256k1.getPublicKey(hexToBytes(CLAIM_KEY), true);
const refundPub = secp256k1.getPublicKey(hexToBytes(REFUND_KEY), true);
const sellerPriv = hexToBytes('33'.repeat(32));
const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
const sellerAddr = p2wpkhAddress(sellerPub, 'regtest');
const buyerBtcAddr = p2wpkhAddress(secp256k1.getPublicKey(hexToBytes('44'.repeat(32)), true), 'regtest');

/** Carteira BTC do vendedor — assina desafios/envelopes em BIP-137 como a Verum Wallet. */
function sellerWallet(): Wallet {
  const sign = (m: string) => {
    const s = secp256k1.sign(bitcoinMessageHash(m), sellerPriv, { prehash: false, format: 'recovered' });
    return Buffer.from(new Uint8Array([27 + (s[0] as number) + 4, ...s.slice(1)])).toString('base64');
  };
  return { network: 'bitcoin', chainId: 'regtest', address: sellerAddr, async sign(env) { return sign(env.message); }, async signMessage(m) { return sign(m); } };
}

/** Lock da Verum Wallet: gasta o UTXO P2WPKH do vendedor e tranca `sats` no cofre P2WSH (BIP-143 assinado de verdade). */
function buildLockTx(utxo: { txid: string; vout: number; value: number }, htlcScriptPubKeyHash: Uint8Array, sats: bigint): string {
  const feeSat = 1000n; const change = BigInt(utxo.value) - sats - feeSat;
  const sellerH160 = ripemd160(sha256(sellerPub));
  const outputs = concatBytes(
    varint(2),
    u64le(sats), varint(34), Uint8Array.of(0x00, 0x20), htlcScriptPubKeyHash,                                      // cofre HTLC
    u64le(change), varint(22), Uint8Array.of(0x00, 0x14), sellerH160,                                              // troco do vendedor
  );
  // scriptCode do P2WPKH = P2PKH do hash160 da pubkey (BIP-143)
  const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), sellerH160, Uint8Array.of(0x88, 0xac));
  const sighash = bip143Sighash({ utxos: [{ txid: utxo.txid, vout: utxo.vout, valueSat: BigInt(utxo.value), confirmations: 150 } as HtlcUtxo], witnessScript: scriptCode }, 0, 0xfffffffd, outputs);
  const sig = concatBytes(secp256k1.sign(sighash, sellerPriv, { prehash: false, format: 'der' }), Uint8Array.of(0x01));
  const ins = concatBytes(varint(1), hexToBytes(utxo.txid).reverse(), u32le(utxo.vout), varint(0), u32le(0xfffffffd));
  const wit = concatBytes(varint(2), varint(sig.length), sig, varint(sellerPub.length), sellerPub);
  return bytesToHex(concatBytes(u32le(2), Uint8Array.of(0x00, 0x01), ins, outputs, wit, u32le(0)));
}

describe('E2E — BTC nativo via HTLC com Esplora regtest e carteira financiando o lock', () => {
  const esplora = new EsploraRegtest();
  let closeApp: (() => Promise<void>) | null = null;
  afterAll(async () => { await closeApp?.(); await esplora.stop(); });

  it('lock assinado pela carteira → fund detecta on-chain → assina → settle revela preimage → claim REAL paga o comprador', async () => {
    const url = await esplora.start();
    const { app } = await makeApp({
      autoSettle: false,
      env: { BITCOIN_ESPLORA_URL: url, BITCOIN_NETWORK: 'regtest', BITCOIN_CLAIM_KEY: CLAIM_KEY, BITCOIN_REFUND_KEY: REFUND_KEY, BITCOIN_CONFIRMATIONS: '1', BITCOIN_FEE_FLOOR_SAT_VB: '1' },
      // Comprador conectado via Solana: o endereço BTC de payout vem da carteira multichain (aqui, injetado).
      btcAddressOf: async (_dealId, role) => (role === 'BUYER' ? buyerBtcAddr : null),
    });
    closeApp = () => app.close();
    // O adapter REAL está registrado no lugar do simulador.
    expect(app.adapters.require('bitcoin').constructor.name).toBe('BitcoinChainAdapter');

    const faucetUtxo = esplora.faucet(sellerAddr, 200_000_000); // 2 BTC maduros para o vendedor
    const parts: Parts = { SELLER: sellerWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.BTC, assetOut: ASSETS.USDC_SOL, amountInBase: '75000000' });
    expect(d.terms!.route.kind).toBe('HTLC');
    const htlcHash = d.terms!.route.htlcHash as string;

    await app.deals.open(d.id, sellerAddr);
    // Ordem HTLC: contrato primeiro; e sem lock on-chain o fund BTC falha com o endereço do cofre.
    expect(await code(app.deals.fund(d.id, 'SELLER', sellerAddr))).toBe('FUNDING_REQUIRED');
    await app.deals.fund(d.id, 'BUYER', parts.BUYER.address);
    const semLock = await app.deals.fund(d.id, 'SELLER', sellerAddr).then(() => null, e => e as { code: string; details?: { address?: string } });
    expect(semLock?.code).toBe('FUNDING_REQUIRED');
    const witnessScript = htlcWitnessScript(htlcHash, claimPub, refundPub, 144);
    const htlcAddr = p2wshAddress(witnessScript, 'regtest');
    expect(semLock?.details?.address).toBe(htlcAddr); // o adapter aponta exatamente o cofre derivado

    // ---- Verum Wallet do vendedor TRANCA o BTC: transação real assinada e transmitida ----
    const lockHex = buildLockTx(faucetUtxo, sha256(witnessScript), 75_000_000n);
    const br = await fetch(`${url}/tx`, { method: 'POST', body: lockHex });
    expect(br.ok, await br.clone().text()).toBe(true);
    esplora.mine(1);
    expect(esplora.utxosOf(htlcAddr).reduce((s, u) => s + u.value, 0)).toBe(75_000_000);

    // Agora o fund BTC detecta o lock on-chain e marca FINAL.
    await app.deals.fund(d.id, 'SELLER', sellerAddr);
    for (const role of SIGNING_ORDER) { const w = parts[role]; if (w) await signAs(app, d.id, role, w); }

    const rec = await app.settlement.settle(d.id);
    expect(rec.status).toBe('DONE');
    expect((await app.deals.get(d.id)).state).toBe('SETTLED');

    // Preimage REAL extraída do witness do claim observado na rede (não do estado interno).
    const preimage = (await app.deals.get(d.id) as Deal & { htlcPreimage?: string }).htlcPreimage as string;
    expect(await app.adapters.require('bitcoin').revealedPreimage(d.id)).toBe(preimage);
    expect(bytesToHex(sha256(hexToBytes(preimage)))).toBe(htlcHash);

    // O claim transmitido gastou o cofre e pagou o COMPRADOR (menos a fee de rede).
    expect(esplora.utxosOf(htlcAddr)).toHaveLength(0);
    const buyerSats = esplora.utxosOf(buyerBtcAddr).reduce((s, u) => s + u.value, 0);
    expect(buyerSats).toBeGreaterThan(74_900_000);
    const claim = esplora.txs.find(t => t.vout.some(o => o.scriptpubkey_address === buyerBtcAddr));
    expect(claim?.vin[0]?.witness[1]).toBe(preimage); // witness do claim carrega a preimage
    expect(claim?.vin[0]?.witness[3]).toBe(bytesToHex(witnessScript));
  }, 120_000);
});
