/**
 * Teste de CONTRATO — dois níveis:
 *
 *  A) Contrato on-chain do escrow (src/onchain, vendorado de verum-otc-onchain): invariantes que o
 *     cliente TS tem de honrar para o contrato aceitar/rejeitar. Vínculo papel↔assinatura, sensibilidade
 *     do tradeId a cada termo, ausência de backdoor administrativo e layout determinístico (EVM/Solana).
 *
 *  B) Contrato da API pública da mesa (public-view): forma/shape acordada que o front consome — campos
 *     presentes, tipos corretos e, por contrato, SEM segredos nem endereço completo.
 *
 * O nível A é determinístico (sem rede). O nível B exercita a API real via inject.
 */
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAddress } from 'viem';
import { Role, type Terms } from '../src/onchain/types.js';
import { TRADE_DURATION_SECONDS } from '../src/onchain/core/index.js';
import {
  hashTermsEvm, computeTradeIdEvm, approvalDigestEvm, signApprovalEvm,
  hashTermsSolana, computeTradeIdSolana, serializeTermsSolana,
} from '../src/onchain/crypto/index.js';
import { ESCROW_ABI } from '../src/onchain/router/adapters/evm.js';
import { TRON_ESCROW_ABI } from '../src/onchain/router/adapters/tron.js';
import { makeApp, solWallet } from './helpers.js';
import type { App } from '../src/app.js';
import type { BalanceReaders } from '../src/mesa/balances.js';

const CHAIN_ID = 11155111;
const ESCROW = '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f';
const USDT = '0x7169d38820dfd117c3fa1f22a697dba58d90ba06';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const START = 1_790_000_000;

function makeTerms(over: Partial<Terms> = {}): Terms {
  return {
    chainId: CHAIN_ID, escrowAddress: ESCROW,
    seller: '0x1111111111111111111111111111111111111111', buyer: '0x2222222222222222222222222222222222222222',
    paymaster01: '0x3333333333333333333333333333333333333333', paymaster02: '0x4444444444444444444444444444444444444444',
    sellerAsset: USDT, sellerAmount: 1_000_000_000_000n,
    buyerAsset: USDC, buyerAmount: 999_000_000_000n,
    platformFeeBps: 3, commissionBps: 200, discountBps: 300, slippageBps: 50,
    createdAt: START, expiresAt: START + TRADE_DURATION_SECONDS, termsVersion: 1, nonce: 1n, commissionPm1: 0n, commissionPm2: 0n,
    ...over,
  };
}

// ───────────────────────── A) Contrato on-chain do escrow ─────────────────────────
describe('Contrato on-chain · aprovação EIP-712 vinculada ao papel', () => {
  const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const acct = privateKeyToAccount(PK);
  const t = makeTerms();
  const termsHash = hashTermsEvm(t);
  const tradeId = computeTradeIdEvm(CHAIN_ID, ESCROW, termsHash);

  it('assinatura de aprovação recupera o signer e é distinta por papel (SELLER ≠ BUYER)', async () => {
    const sSeller = await signApprovalEvm(PK, CHAIN_ID, ESCROW, tradeId, termsHash, Role.SELLER, t.expiresAt);
    const sBuyer = await signApprovalEvm(PK, CHAIN_ID, ESCROW, tradeId, termsHash, Role.BUYER, t.expiresAt);
    expect(sSeller.signer).toBe(acct.address);
    expect(sSeller.signature).toMatch(/^0x[0-9a-f]{130}$/);
    // A MESMA chave e os MESMOS termos, mudando só o papel, produzem assinaturas diferentes:
    // o contrato não deixa reusar a aprovação de um papel como a de outro.
    expect(sBuyer.signature).not.toBe(sSeller.signature);
  });

  it('a assinatura de SELLER só recupera o signer no digest de SELLER, não no de BUYER (replay de papel falha)', async () => {
    const sSeller = await signApprovalEvm(PK, CHAIN_ID, ESCROW, tradeId, termsHash, Role.SELLER, t.expiresAt);
    // approvalDigestEvm devolve EXATAMENTE o digest EIP-712 que signApprovalEvm assina — então
    // recoverAddress sobre esse digest é a verificação canônica (idêntica à do contrato).
    const sellerDigest = approvalDigestEvm(CHAIN_ID, ESCROW, tradeId, termsHash, Role.SELLER, t.expiresAt);
    const buyerDigest = approvalDigestEvm(CHAIN_ID, ESCROW, tradeId, termsHash, Role.BUYER, t.expiresAt);
    expect(buyerDigest).not.toBe(sellerDigest);

    const recOk = await recoverAddress({ hash: sellerDigest, signature: sSeller.signature as `0x${string}` });
    const recWrong = await recoverAddress({ hash: buyerDigest, signature: sSeller.signature as `0x${string}` });
    expect(recOk.toLowerCase()).toBe(acct.address.toLowerCase());            // papel certo: verifica
    expect(recWrong.toLowerCase()).not.toBe(acct.address.toLowerCase());     // papel errado: NÃO verifica
  });
});

describe('Contrato on-chain · tradeId/termsHash sensíveis a cada termo', () => {
  const base = makeTerms();
  const baseId = computeTradeIdEvm(CHAIN_ID, ESCROW, hashTermsEvm(base));

  it('qualquer alteração material nos termos muda o termsHash e o tradeId', () => {
    const mutações: Partial<Terms>[] = [
      { sellerAmount: base.sellerAmount + 1n },
      { buyerAmount: base.buyerAmount + 1n },
      { buyer: '0x9999999999999999999999999999999999999999' },
      { commissionBps: base.commissionBps + 1 },
      { discountBps: base.discountBps + 1 },
      { nonce: base.nonce + 1n },
      { expiresAt: base.expiresAt + 1 },
    ];
    for (const m of mutações) {
      const label = Object.keys(m)[0]!; // rótulo simples (JSON.stringify não serializa BigInt)
      const t2 = makeTerms(m);
      expect(hashTermsEvm(t2), label).not.toBe(hashTermsEvm(base));
      expect(computeTradeIdEvm(CHAIN_ID, ESCROW, hashTermsEvm(t2)), label).not.toBe(baseId);
    }
  });

  it('tradeId muda com a rede (chainId) e com o endereço do contrato (anti-replay cross-chain)', () => {
    const th = hashTermsEvm(base);
    expect(computeTradeIdEvm(CHAIN_ID + 1, ESCROW, th)).not.toBe(baseId);
    expect(computeTradeIdEvm(CHAIN_ID, '0x000000000000000000000000000000000000dead', th)).not.toBe(baseId);
  });
});

describe('Contrato on-chain · superfície segura do ABI e layout determinístico', () => {
  it('nenhum ABI (EVM/Tron) expõe saque administrativo, upgrade ou resgate', () => {
    for (const abi of [ESCROW_ABI, TRON_ESCROW_ABI]) {
      const names = abi.filter(x => (x as { type: string }).type === 'function').map(x => (x as { name: string }).name.toLowerCase());
      for (const forbidden of ['withdraw', 'admintransfer', 'sweep', 'upgradeto', 'setimplementation', 'rescue', 'emergencywithdraw', 'selfdestruct', 'setowner']) {
        expect(names.some(n => n.includes(forbidden)), `${forbidden} presente no ABI`).toBe(false);
      }
    }
  });

  it('Solana: serialização borsh dos termos é determinística e de tamanho fixo (260 bytes — termos v2)', () => {
    // serializeTermsSolana exige pubkeys base58 (não endereços EVM 0x…).
    const t = makeTerms({
      chainId: 103, escrowAddress: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      seller: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', buyer: '9vYWHBPz817wJdQpE8u3h1qTTe3x4L7DJhm2x9ZPt4g6',
      paymaster01: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', paymaster02: 'GkVvdvAvo3g4VxKyGThLByzePKktuMAAN9vhNyQXuo4z',
      sellerAsset: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', buyerAsset: 'So11111111111111111111111111111111111111112',
    });
    const a = serializeTermsSolana(t); const b = serializeTermsSolana(t);
    expect(a.length).toBe(260);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true); // determinístico
    const id1 = computeTradeIdSolana('So11111111111111111111111111111111111111112', hashTermsSolana(t));
    const id2 = computeTradeIdSolana('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', hashTermsSolana(t));
    // Uint8Array → compara conteúdo (não referência): tradeId sensível ao programa (anti-replay cross-program).
    expect(Buffer.from(id1).equals(Buffer.from(id2))).toBe(false);
  });
});

// ───────────────────────── B) Contrato da API pública ─────────────────────────
const SOL_ASSET = { network: 'solana', contractOrMint: null, decimals: 9, symbol: 'SOL' };
const USDC_ASSET = { network: 'solana', contractOrMint: 'USDC1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC' };
function readers(): BalanceReaders { return { native: async () => ({ amount: 1000 }), tokens: async () => [], priceUsdOf: async () => 150 }; }
const pmHeaders = (t: string) => ({ authorization: `Bearer ${t}` });
async function setupMesa(app: App): Promise<string> {
  const reg = await app.api.inject({ method: 'POST', url: '/v1/portal/register', payload: { name: 'PM Contrato', email: `ct-${Date.now()}-${Math.floor(Math.random() * 1e6)}@verum.test`, password: 'senha-forte-1' } });
  const token = reg.json<{ token: string }>().token;
  const w = solWallet();
  await app.api.inject({ method: 'POST', url: '/v1/portal/wallet/connect', headers: pmHeaders(token), payload: { address: w.address, network: 'solana' } });
  const m = await app.api.inject({ method: 'POST', url: '/v1/portal/mesas', headers: pmHeaders(token), payload: { network: 'solana', chairs: [
    { role: 'SELLER', expectedAsset: SOL_ASSET }, { role: 'BUYER', expectedAsset: USDC_ASSET },
  ] } });
  return m.json<{ mesaId: string }>().mesaId;
}

describe('Contrato da API · GET /v1/mesas/:id/public-view', () => {
  it('cumpre o shape acordado (campos e tipos) consumido pelo front', async () => {
    const { app } = await makeApp({ balanceReaders: readers() });
    const mesaId = await setupMesa(app);
    const pv = await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaId}/public-view` });
    expect(pv.statusCode).toBe(200);
    const v = pv.json<Record<string, unknown>>();
    // Campos de topo exigidos pela UI de leitura (/ver).
    for (const k of ['mesaId', 'code', 'network', 'networkLabel', 'status', 'createdAt', 'serverTime', 'chairs']) {
      expect(v, `campo ausente: ${k}`).toHaveProperty(k);
    }
    expect(typeof v.mesaId).toBe('string');
    expect(typeof v.status).toBe('string');
    expect(Array.isArray(v.chairs)).toBe(true);
    // Mesa v3 não expira por padrão (expiresAt null) — contrato que a UI usa p/ esconder "Expira em".
    expect(v.expiresAt).toBeNull();
    // Cada cadeira traz o shape que a UI renderiza.
    for (const c of v.chairs as Record<string, unknown>[]) {
      for (const k of ['role', 'roleLabel', 'asset', 'network', 'assetNetworkLabel', 'decimals', 'connected']) {
        expect(c, `cadeira sem campo: ${k}`).toHaveProperty(k);
      }
      expect(typeof c.connected).toBe('boolean');
      expect(typeof c.decimals).toBe('number');
    }
  });

  it('por contrato NÃO inclui chaves sensíveis (codeHash, token, invites, notes, payMasterId)', async () => {
    const { app } = await makeApp({ balanceReaders: readers() });
    const mesaId = await setupMesa(app);
    const pv = await app.api.inject({ method: 'GET', url: `/v1/mesas/${mesaId}/public-view` });
    const raw = pv.body.toLowerCase();
    for (const forbidden of ['codehash', 'paymasterid', 'invites', 'invitecode', 'notes', '"token"', 'secret']) {
      expect(raw.includes(forbidden), `vazou "${forbidden}"`).toBe(false);
    }
  });

  it('mesa inexistente ⇒ erro de domínio (não 500)', async () => {
    const { app } = await makeApp({ balanceReaders: readers() });
    const pv = await app.api.inject({ method: 'GET', url: '/v1/mesas/mesa_inexistente_999/public-view' });
    expect(pv.statusCode).toBeGreaterThanOrEqual(400);
    expect(pv.statusCode).toBeLessThan(500);
  });
});
