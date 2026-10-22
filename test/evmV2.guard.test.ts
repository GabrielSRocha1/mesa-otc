/**
 * Guard de ativos do escrow V2 (incidente 'execution reverted' 2026-10-22): antes de montar o
 * createTradeV2, o adapter checa que o escrow CONFIGURADO aceita os ativos das pernas — ETH nativo
 * exige NATIVE_ASSET() no contrato (escrow WETH-era não tem → env no escrow errado); token exige
 * isTokenActive. Testa a lógica com `view` stubado (sem RPC real).
 */
import { describe, it, expect } from 'vitest';
import { VerumEvmV2Adapter } from '../src/adapters/verum/evmV2.js';

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TOKEN = '0x7DFdcc43D60C12634E24044eCE13ed6b031B6743';
const EXTERNAL = '0x0000000000000000000000000000000000000000'; // perna externa (HTLC)

function makeAdapter(view: (fn: string, args?: unknown[]) => Promise<unknown>): VerumEvmV2Adapter {
  const cfg = {
    rpcUrl: 'http://127.0.0.1:1', chainId: 11155111, escrow: ('0x' + '11'.repeat(20)) as `0x${string}`,
    escrowV2: ('0x' + '22'.repeat(20)) as `0x${string}`, keeperKey: ('0x' + '11'.repeat(32)) as `0x${string}`,
    attestorKey: ('0x' + '22'.repeat(32)) as `0x${string}`, tbtc: ('0x' + '33'.repeat(20)) as `0x${string}`,
    tusdt: TOKEN as `0x${string}`, confirmations: 1, explorerBase: null,
  };
  const a = new VerumEvmV2Adapter(cfg, null, {} as never);
  (a as unknown as { view: unknown }).view = (fn: string, args?: unknown[]) => view(fn, args);
  return a;
}
const assertAssets = (a: VerumEvmV2Adapter, sellerAsset: string, buyerAsset: string): Promise<void> =>
  (a as unknown as { assertAssetsAcceptable: (t: unknown) => Promise<void> }).assertAssetsAcceptable({ sellerAsset, buyerAsset });
const codeOf = (p: Promise<unknown>) => p.then(() => null, e => (e as { code?: string; message?: string }).message ?? 'ERRO');

describe('Guard de ativos do escrow V2', () => {
  it('ETH nativo num escrow SEM NATIVE_ASSET() → erro acionável (env no escrow errado)', async () => {
    const a = makeAdapter(async fn => { if (fn === 'NATIVE_ASSET') throw new Error('execution reverted'); return true; });
    const msg = await codeOf(assertAssets(a, EXTERNAL, NATIVE)); // BTC(externo) ↔ ETH nativo
    expect(msg).toMatch(/NÃO suporta ETH nativo/);
    expect(msg).toMatch(/VERUM_EVM_V2_ESCROW_ADDRESS/);
  });

  it('ETH nativo num escrow COM NATIVE_ASSET() → passa (sem addToken do sentinel)', async () => {
    let probes = 0;
    const a = makeAdapter(async fn => { if (fn === 'NATIVE_ASSET') { probes++; return NATIVE; } return true; });
    await expect(assertAssets(a, EXTERNAL, NATIVE)).resolves.toBeUndefined();
    await assertAssets(a, EXTERNAL, NATIVE); // 2ª vez: usa cache, não re-sonda
    expect(probes).toBe(1);
  });

  it('token NÃO ativo no escrow → erro pedindo addToken do owner', async () => {
    const a = makeAdapter(async (fn, args) => { if (fn === 'isTokenActive') return (args?.[0] as string) !== TOKEN; return true; });
    const msg = await codeOf(assertAssets(a, TOKEN, ('0x' + '44'.repeat(20))));
    expect(msg).toMatch(/não está habilitado/);
    expect(msg).toMatch(/addToken/);
  });

  it('ambos tokens ativos → passa; perna externa (0x0…0) é ignorada', async () => {
    const a = makeAdapter(async fn => { if (fn === 'isTokenActive') return true; return true; });
    await expect(assertAssets(a, TOKEN, ('0x' + '44'.repeat(20)))).resolves.toBeUndefined();
    await expect(assertAssets(a, EXTERNAL, EXTERNAL)).resolves.toBeUndefined(); // nada a checar
  });
});
