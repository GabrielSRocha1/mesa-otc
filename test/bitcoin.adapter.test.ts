/**
 * BitcoinChainAdapter real — script HTLC P2WSH do ADR-v4, endereço bech32, transação segwit
 * assinada (BIP-143) e monitoramento da preimage no witness do gasto (Esplora mockado).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';
import {
  BitcoinChainAdapter, htlcWitnessScript, p2wshAddress, p2wpkhAddress, outputScriptOf,
  buildHtlcSpend, bip143Sighash, preimageFromWitness, scriptNum, varint, type BitcoinSettings, type HtlcUtxo,
} from '../src/adapters/bitcoin.js';
import type { Deal } from '../src/domain/types.js';

const claimPriv = hexToBytes('11'.repeat(32));
const refundPriv = hexToBytes('22'.repeat(32));
const claimPub = secp256k1.getPublicKey(claimPriv, true);
const refundPub = secp256k1.getPublicKey(refundPriv, true);
const preimage = 'ab'.repeat(32);
const htlcHash = bytesToHex(sha256(hexToBytes(preimage)));

const CFG: BitcoinSettings = { esploraUrl: 'http://esplora.test', network: 'regtest', claimKey: bytesToHex(claimPriv), refundKey: bytesToHex(refundPriv), confirmations: 3, csvBlocks: 144, feeFloorSatVb: 2 };

describe('script HTLC + endereço P2WSH', () => {
  it('layout bate com o ADR-v4: IF SHA256 <hash> EQUALVERIFY <claim> CHECKSIG ELSE <144> CSV DROP <refund> CHECKSIG ENDIF', () => {
    const s = htlcWitnessScript(htlcHash, claimPub, refundPub, 144);
    const hex = bytesToHex(s);
    expect(hex.startsWith('63a820' + htlcHash + '88' + '21' + bytesToHex(claimPub) + 'ac')).toBe(true);
    expect(hex).toContain('67' + '02' + '9000' + 'b275' + '21' + bytesToHex(refundPub) + 'ac');
    expect(hex.endsWith('68')).toBe(true);
  });
  it('CSV usa CScriptNum minimal (144 → 0x9000, com byte de sinal)', () => {
    expect(bytesToHex(scriptNum(144))).toBe('9000');
    expect(bytesToHex(scriptNum(127))).toBe('7f');
    expect(bytesToHex(scriptNum(255))).toBe('ff00');
    expect(() => scriptNum(0)).toThrow();
  });
  it('endereço P2WSH = bech32 v0 de sha256(witnessScript) — roundtrip de decodificação', () => {
    const s = htlcWitnessScript(htlcHash, claimPub, refundPub, 144);
    const addr = p2wshAddress(s, 'regtest');
    expect(addr.startsWith('bcrt1q')).toBe(true);
    const dec = bech32.decode(addr as `${string}1${string}`, 120);
    expect(dec.words[0]).toBe(0);
    expect(bytesToHex(Uint8Array.from(bech32.fromWords(dec.words.slice(1))))).toBe(bytesToHex(sha256(s)));
  });
  it('outputScriptOf aceita bech32 v0 da própria rede e rejeita rede errada/lixo', () => {
    const w = p2wpkhAddress(claimPub, 'regtest');
    expect(bytesToHex(outputScriptOf(w, 'regtest')).startsWith('0014')).toBe(true);
    const htlcAddr = p2wshAddress(htlcWitnessScript(htlcHash, claimPub, refundPub, 144), 'regtest');
    expect(bytesToHex(outputScriptOf(htlcAddr, 'regtest')).startsWith('0020')).toBe(true);
    expect(() => outputScriptOf(p2wpkhAddress(claimPub, 'testnet'), 'regtest')).toThrow();
    expect(() => outputScriptOf('bcrt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'regtest')).toThrow();
  });
});

describe('transação de gasto do HTLC (BIP-143 + witness)', () => {
  const witnessScript = htlcWitnessScript(htlcHash, claimPub, refundPub, 144);
  const payout = outputScriptOf(p2wpkhAddress(refundPub, 'regtest'), 'regtest');
  const utxos: HtlcUtxo[] = [{ txid: 'f'.repeat(64), vout: 0, valueSat: 250_000n, confirmations: 10 }];

  /** Parse mínimo do claim (1-in/1-out segwit v2) devolvendo outputs serializados e itens do witness. */
  function parseClaim(hex: string): { outputs: Uint8Array; witness: string[] } {
    expect(hex.startsWith('02000000' + '0001')).toBe(true);
    let i = 12; // version + marker/flag
    expect(hex.slice(i, i + 2)).toBe('01'); i += 2;          // 1 input
    i += 64 + 8 + 2 + 8;                                     // outpoint + scriptSig vazio + sequence
    expect(hex.slice(i, i + 2)).toBe('01'); i += 2;          // 1 output (contagem fica FORA do hashOutputs)
    const outStart = i;
    i += 16;                                                 // value
    const scriptLen = parseInt(hex.slice(i, i + 2), 16); i += 2 + scriptLen * 2;
    const outputs = hexToBytes(hex.slice(outStart, i));
    const nItems = parseInt(hex.slice(i, i + 2), 16); i += 2;
    const witness: string[] = [];
    for (let k = 0; k < nItems; k++) { const len = parseInt(hex.slice(i, i + 2), 16); i += 2; witness.push(hex.slice(i, i + len * 2)); i += len * 2; }
    expect(hex.slice(i)).toBe('00000000');                   // locktime
    return { outputs, witness };
  }

  it('claim: witness [sig, preimage, 01, script], fee > 0 e assinatura DER VÁLIDA sobre o sighash BIP-143', () => {
    const built = buildHtlcSpend({ utxos, witnessScript, payoutScript: payout, satPerVb: 2, path: 'claim', preimage, keyPriv: claimPriv, csvBlocks: 144 });
    expect(built.feeSat).toBeGreaterThan(0n);
    expect(built.vsize).toBeGreaterThan(100);
    expect(built.txid).toMatch(/^[0-9a-f]{64}$/);
    const { outputs, witness } = parseClaim(built.hex);
    expect(witness).toHaveLength(4);
    expect(witness[1]).toBe(preimage);
    expect(witness[2]).toBe('01');
    expect(witness[3]).toBe(bytesToHex(witnessScript));
    const sig = hexToBytes(witness[0] as string);
    expect(sig[sig.length - 1]).toBe(0x01); // SIGHASH_ALL
    const sighash = bip143Sighash({ utxos, witnessScript }, 0, 0xfffffffd, outputs);
    expect(secp256k1.verify(sig.slice(0, -1), sighash, claimPub, { prehash: false, format: 'der' })).toBe(true);
  });
  it('refund: witness [sig, vazio, script] e nSequence = 144 (CSV de blocos)', () => {
    const built = buildHtlcSpend({ utxos, witnessScript, payoutScript: payout, satPerVb: 2, path: 'refund', keyPriv: refundPriv, csvBlocks: 144 });
    // sequence LE do input: 144 = 0x00000090 → '90000000' logo após o scriptSig vazio do outpoint
    expect(built.hex.slice(12 + 2 + 64 + 8 + 2, 12 + 2 + 64 + 8 + 2 + 8)).toBe('90000000');
    const { witness } = parseClaim(built.hex);
    expect(witness).toHaveLength(3);
    expect(witness[1]).toBe('');
    expect(witness[2]).toBe(bytesToHex(witnessScript));
  });
  it('valor que não cobre a taxa (dust) é rejeitado com motivo nominal', () => {
    expect(() => buildHtlcSpend({ utxos: [{ ...utxos[0] as HtlcUtxo, valueSat: 500n }], witnessScript, payoutScript: payout, satPerVb: 2, path: 'claim', preimage, keyPriv: claimPriv, csvBlocks: 144 }))
      .toThrow(/dust|taxa/);
  });
  it('preimageFromWitness acha o item de 32 bytes cujo sha256 == htlcHash (e só ele)', () => {
    expect(preimageFromWitness(['30440220'.padEnd(140, '0'), preimage, '01', bytesToHex(witnessScript)], htlcHash)).toBe(preimage);
    expect(preimageFromWitness(['cd'.repeat(32), '01'], htlcHash)).toBeNull();
  });
  it('varint cobre os três tamanhos', () => {
    expect(bytesToHex(varint(0xfc))).toBe('fc');
    expect(bytesToHex(varint(0xfd))).toBe('fdfd00');
    expect(bytesToHex(varint(0x10000))).toBe('fe00000100');
  });
});

describe('adapter com Esplora mockado — monitoramento do gasto e extração da preimage', () => {
  afterEach(() => vi.unstubAllGlobals());

  const witnessScript = htlcWitnessScript(htlcHash, claimPub, refundPub, 144);
  const htlcAddr = p2wshAddress(witnessScript, 'regtest');
  const fundingTxid = 'f'.repeat(64);
  const legBtc = { index: 0, from: 'SELLER', to: 'BUYER', escrowChain: 'bitcoin', escrowContract: htlcAddr, mode: 'HTLC', amountBase: '100000', asset: { network: 'bitcoin', chainId: 'regtest', contractOrMint: null, code: 'BTC', decimals: 8, tokenStandard: 'native' } };
  const deal = {
    id: 'OTC-btc-1', terms: {
      route: { htlcHash }, legs: [legBtc], expiresAt: Date.now() + 3600_000,
      participants: [
        { role: 'SELLER', network: 'bitcoin', chainId: 'regtest', address: p2wpkhAddress(refundPub, 'regtest') },
        { role: 'BUYER', network: 'bitcoin', chainId: 'regtest', address: p2wpkhAddress(claimPub, 'regtest') },
      ],
    },
  } as unknown as Deal;

  function stubEsplora(routes: Record<string, unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url).replace('http://esplora.test', '');
      for (const [suffix, body] of Object.entries(routes)) if (path === suffix) {
        return { ok: true, status: 200, json: async () => body, text: async () => String(body) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' } as Response;
    }));
  }

  it('revealedPreimage lê a preimage REAL do witness do claim on-chain', async () => {
    const spendTx = { txid: 'e'.repeat(64), status: { confirmed: true, block_height: 120 }, vin: [{ txid: fundingTxid, vout: 0, witness: ['30'.padEnd(140, '0'), preimage, '01', bytesToHex(witnessScript)] }], vout: [] };
    const fundingTx = { txid: fundingTxid, status: { confirmed: true, block_height: 100 }, vin: [], vout: [{ scriptpubkey_address: htlcAddr, value: 100000 }] };
    stubEsplora({ [`/address/${htlcAddr}/txs`]: [spendTx, fundingTx] });
    const a = new BitcoinChainAdapter(CFG, { getDeal: async () => deal });
    expect(await a.revealedPreimage('OTC-btc-1')).toBe(preimage);
    const st = await a.getDealState('OTC-btc-1');
    expect(st.status).toBe('SETTLED');
    expect(st.settledTx).toBe(spendTx.txid);
  });

  it('sem gasto: FUNDED com confirmações suficientes; deposit exige o lock com motivo nominal', async () => {
    const fundingTx = { txid: fundingTxid, status: { confirmed: true, block_height: 100 }, vin: [], vout: [{ scriptpubkey_address: htlcAddr, value: 100000 }] };
    stubEsplora({
      [`/address/${htlcAddr}/txs`]: [fundingTx],
      [`/address/${htlcAddr}/utxo`]: [{ txid: fundingTxid, vout: 0, value: 100000, status: { confirmed: true, block_height: 100 } }],
      '/blocks/tip/height': 110,
    });
    const a = new BitcoinChainAdapter(CFG, { getDeal: async () => deal });
    expect((await a.getDealState('OTC-btc-1')).status).toBe('FUNDED');
    const dep = await a.deposit('OTC-btc-1', 0, 'qualquer');
    expect(dep.ref).toBe(fundingTxid);
  });

  it('HTLC vazio: deposit lança FUNDING_REQUIRED apontando o endereço P2WSH do cofre', async () => {
    stubEsplora({ [`/address/${htlcAddr}/txs`]: [], [`/address/${htlcAddr}/utxo`]: [], '/blocks/tip/height': 110 });
    const a = new BitcoinChainAdapter(CFG, { getDeal: async () => deal });
    await expect(a.deposit('OTC-btc-1', 0, 'x')).rejects.toMatchObject({ code: 'FUNDING_REQUIRED', details: { address: htlcAddr } });
    expect(await a.revealedPreimage('OTC-btc-1')).toBeNull();
  });

  it('registerDeal é determinístico e devolve meta persistível (endereço/script/CSV)', async () => {
    stubEsplora({});
    const a = new BitcoinChainAdapter(CFG);
    const commit = { dealId: 'OTC-btc-1', revision: 1, dealHash: 'x', expiresAt: Date.now() + 3600_000, participants: (deal.terms as NonNullable<Deal['terms']>).participants, legs: [legBtc], pricingHash: '', routeHash: '', domainHash: '', dealNonce: '', feeBps: 3, treasury: '', htlcHash, terms: deal.terms } as never;
    const r = await a.registerDeal(commit);
    expect(r.meta?.htlcAddress).toBe(htlcAddr);
    expect(r.meta?.csvBlocks).toBe(144);
    expect(r.meta?.witnessScript).toBe(bytesToHex(witnessScript));
  });
});
