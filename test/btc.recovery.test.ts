/**
 * Recuperação da perna BTC (auditoria 2026-10-19) — cenários que só a rede real revela, reproduzidos
 * de forma determinística no Esplora regtest in-process:
 *   1. ABANDONO/substituição do lock: tx some do mempool/cadeia antes do FINAL → funding nunca avança.
 *   2. REORG após FINAL: o lock some depois de confirmado → a liquidação é RECUSADA (nunca SETTLED),
 *      a deal vira BLOCKED e a perna de contrato é reembolsada.
 *   3. REFUND pós-CSV: operação expira com BTC trancado → reembolso fica PENDING até o timelock
 *      (144 blocos) vencer e então sai pelo retryRefunds — e NUNCA executa duas vezes (guard).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { makeApp, prepareDeal, solWallet, ASSETS, fullySign, type Parts, type Wallet } from './helpers.js';
import { bitcoinMessageHash } from '../src/engines/signature.js';
import { htlcWitnessScript, p2wshAddress, p2wpkhAddress, bip143Sighash, varint, type HtlcUtxo } from '../src/adapters/bitcoin.js';
import { EsploraRegtest } from './esploraRegtest.js';

const u32le = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

const CLAIM_KEY = '11'.repeat(32); const REFUND_KEY = '22'.repeat(32);
const claimPub = secp256k1.getPublicKey(hexToBytes(CLAIM_KEY), true);
const refundPub = secp256k1.getPublicKey(hexToBytes(REFUND_KEY), true);
const sellerPriv = hexToBytes('55'.repeat(32));
const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
const sellerAddr = p2wpkhAddress(sellerPub, 'regtest');
const buyerBtcAddr = p2wpkhAddress(secp256k1.getPublicKey(hexToBytes('66'.repeat(32)), true), 'regtest');

function sellerWallet(): Wallet {
  const sign = (m: string) => { const s = secp256k1.sign(bitcoinMessageHash(m), sellerPriv, { prehash: false, format: 'recovered' }); return Buffer.from(new Uint8Array([27 + (s[0] as number) + 4, ...s.slice(1)])).toString('base64'); };
  return { network: 'bitcoin', chainId: 'regtest', address: sellerAddr, async sign(env) { return sign(env.message); }, async signMessage(m) { return sign(m); } };
}
function buildLockTx(utxo: { txid: string; vout: number; value: number }, htlcScriptPubKeyHash: Uint8Array, sats: bigint): string {
  const feeSat = 1000n; const change = BigInt(utxo.value) - sats - feeSat;
  const sellerH160 = ripemd160(sha256(sellerPub));
  const outputsBody = concatBytes(u64le(sats), varint(34), Uint8Array.of(0x00, 0x20), htlcScriptPubKeyHash, u64le(change), varint(22), Uint8Array.of(0x00, 0x14), sellerH160);
  const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), sellerH160, Uint8Array.of(0x88, 0xac));
  const sighash = bip143Sighash({ utxos: [{ txid: utxo.txid, vout: utxo.vout, valueSat: BigInt(utxo.value), confirmations: 150 } as HtlcUtxo], witnessScript: scriptCode }, 0, 0xfffffffd, outputsBody);
  const sig = concatBytes(secp256k1.sign(sighash, sellerPriv, { prehash: false, format: 'der' }), Uint8Array.of(0x01));
  const ins = concatBytes(varint(1), hexToBytes(utxo.txid).reverse(), u32le(utxo.vout), varint(0), u32le(0xfffffffd));
  const wit = concatBytes(varint(2), varint(sig.length), sig, varint(sellerPub.length), sellerPub);
  return bytesToHex(concatBytes(u32le(2), Uint8Array.of(0x00, 0x01), ins, varint(2), outputsBody, wit, u32le(0)));
}
const SATS = 75_000_000n;
const btcEnv = (url: string, confirmations = '1') => ({ BITCOIN_ESPLORA_URL: url, BITCOIN_NETWORK: 'regtest', BITCOIN_CLAIM_KEY: CLAIM_KEY, BITCOIN_REFUND_KEY: REFUND_KEY, BITCOIN_CONFIRMATIONS: confirmations, BITCOIN_FEE_FLOOR_SAT_VB: '1' });
const codeOf = (p: Promise<unknown>) => p.then(() => null, e => (e as { code?: string }).code ?? 'ERRO');

describe('Perna BTC — abandono e reorg', () => {
  const esplora = new EsploraRegtest();
  let closeApp: (() => Promise<void>) | null = null;
  afterAll(async () => { await closeApp?.(); await esplora.stop(); });

  it('lock abandonado (some antes do FINAL) nunca financia; reorg após FINAL bloqueia a liquidação e reembolsa o contrato', async () => {
    const url = await esplora.start();
    const { app } = await makeApp({ autoSettle: false, env: btcEnv(url), btcAddressOf: async (_d, role) => (role === 'BUYER' ? buyerBtcAddr : null) });
    closeApp = () => app.close();

    // ---- cenário 1: ABANDONO antes do FINAL ----
    const u1 = esplora.faucet(sellerAddr, 200_000_000);
    const parts: Parts = { SELLER: sellerWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d1 = await prepareDeal(app, parts, { assetIn: ASSETS.BTC, assetOut: ASSETS.USDC_SOL, amountInBase: SATS.toString() });
    const script1 = htlcWitnessScript(d1.terms!.route.htlcHash as string, claimPub, refundPub, 144);
    const vault1 = p2wshAddress(script1, 'regtest');
    const lock1 = await (await fetch(`${url}/tx`, { method: 'POST', body: buildLockTx(u1, sha256(script1), SATS) })).text();
    esplora.reorg(lock1); // a tx some (abandonada/substituída) ANTES de qualquer detecção
    expect(await codeOf(app.deals.fund(d1.id, 'SELLER', sellerAddr))).toBe('FUNDING_REQUIRED'); // cofre vazio de novo
    expect((await app.deals.get(d1.id)).participants.find(p => p.role === 'SELLER')!.funding).not.toBe('FINAL');
    expect(await codeOf(app.deals.open(d1.id, sellerAddr))).toBe('FUNDING_REQUIRED');           // open continua recusado
    expect(esplora.utxosOf(vault1)).toHaveLength(0);

    // ---- cenário 2: REORG depois do FINAL (lock some após confirmado) ----
    const u2 = esplora.faucet(sellerAddr, 200_000_000);
    const lock2 = await (await fetch(`${url}/tx`, { method: 'POST', body: buildLockTx(u2, sha256(script1), SATS) })).text();
    esplora.mine(1);
    await app.deals.fund(d1.id, 'SELLER', sellerAddr);                                          // FINAL
    const signed = await fullySign(app, d1.id, parts);                                          // open + funding BUYER + 3 assinaturas
    expect(signed.state).toBe('SETTLEMENT_VALIDATION');
    esplora.reorg(lock2);                                                                       // REORG: o lock confirmado desaparece
    await expect(app.settlement.settle(d1.id)).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    const after = await app.deals.get(d1.id);
    expect(after.state).toBe('BLOCKED');                                                        // nunca SETTLED
    // a perna de CONTRATO (comprador) volta; a BTC não tem o que devolver (o lock sumiu com o reorg)
    expect(after.refunds.find(r => r.role === 'BUYER')?.status).toBe('REFUNDED');
    expect(esplora.utxosOf(buyerBtcAddr)).toHaveLength(0);                                      // nenhum claim aconteceu
  }, 120_000);
});

describe('Perna BTC — refund pós-timelock (CSV) e guard de dupla execução', () => {
  const esplora = new EsploraRegtest();
  let closeApp: (() => Promise<void>) | null = null;
  afterAll(async () => { await closeApp?.(); await esplora.stop(); });

  it('deal expira com BTC trancado → refund PENDING até os 144 blocos → sai sozinho no retry → nunca duplica', async () => {
    const url = await esplora.start();
    const { app, clock } = await makeApp({ autoSettle: false, env: btcEnv(url), btcAddressOf: async (_d, role) => (role === 'BUYER' ? buyerBtcAddr : null) });
    closeApp = () => app.close();
    const u = esplora.faucet(sellerAddr, 200_000_000);
    const parts: Parts = { SELLER: sellerWallet(), BUYER: solWallet(), PAYMASTER_1: solWallet() };
    const d = await prepareDeal(app, parts, { assetIn: ASSETS.BTC, assetOut: ASSETS.USDC_SOL, amountInBase: SATS.toString(), expiresInSec: 900 });
    const script = htlcWitnessScript(d.terms!.route.htlcHash as string, claimPub, refundPub, 144);
    const vault = p2wshAddress(script, 'regtest');
    await (await fetch(`${url}/tx`, { method: 'POST', body: buildLockTx(u, sha256(script), SATS) })).text();
    esplora.mine(1);
    await app.deals.fund(d.id, 'SELLER', sellerAddr);                       // lock FINAL ainda PRÉ-OPEN

    clock.advance(901_000);                                                 // estoura o prazo da operação
    await app.deals.expireDue();
    let now = await app.deals.get(d.id);
    expect(now.state).toBe('REFUNDING');                                    // EXPIRED → REFUNDING automático
    expect(now.refunds.find(r => r.role === 'SELLER')?.status).toBe('PENDING'); // CSV ainda imaturo (1 < 144)
    expect(esplora.utxosOf(vault).reduce((s, x) => s + x.value, 0)).toBe(Number(SATS)); // BTC segue no cofre

    await app.deals.retryRefunds(d.id);                                     // antes do timelock: continua PENDING
    expect((await app.deals.get(d.id)).state).toBe('REFUNDING');

    esplora.mine(144);                                                      // timelock CSV vence
    now = await app.deals.retryRefunds(d.id);
    expect(now.state).toBe('REFUNDED');
    expect(esplora.utxosOf(vault)).toHaveLength(0);                         // cofre esvaziado pelo refund
    const back = esplora.utxosOf(sellerAddr).filter(x => x.txid !== u.txid).reduce((s, x) => s + x.value, 0);
    expect(back).toBeGreaterThan(Number(SATS) - 100_000);                   // vendedor recebeu (menos fees)

    const txCount = esplora.txs.length;
    await app.deals.retryRefunds(d.id);                                     // reexecução: nada acontece
    expect(esplora.txs.length).toBe(txCount);
    expect((await app.deals.get(d.id)).state).toBe('REFUNDED');
  }, 120_000);
});
