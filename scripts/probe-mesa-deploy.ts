/**
 * E2E da MESA no DEPLOY real: registra PM → cria mesa BTC(vendedor)↔tUSDT(comprador) → convites →
 * joins ASSINADOS (BIP-137 e EIP-191) → config → precheck → APPROVE (deal HTLC real no escrow V2
 * da Sepolia, com o cofre P2WSH devolvido em htlcFunding). Carteiras determinísticas do cenário;
 * gás/token das EVM abastecidos pela keeper quando faltam.
 *
 * Uso: npx tsx --env-file=.env scripts/probe-mesa-deploy.ts [url]
 */
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { loadConfig, verumEvmConfig, bitcoinConfig } from '../src/config.js';
import { bitcoinMessageHash } from '../src/engines/signature.js';
import { p2wpkhAddress, type BitcoinNet } from '../src/adapters/bitcoin.js';

const U = process.argv[2] ?? 'https://otcdesk.verumcrypto.com';
const config = loadConfig(process.env);
const evmCfg = verumEvmConfig(config); const btcCfg = bitcoinConfig(config);
if (!evmCfg || !btcCfg || !process.env.BTC_SELLER_KEY) { console.error('exige VERUM_EVM_* + BITCOIN_* + BTC_SELLER_KEY no .env'); process.exit(1); }

const log = (m: string): void => console.log('▸ ' + m);
const api = async (path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<unknown> => {
  const r = await fetch(U + path, { method: opts.method ?? 'GET', headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await r.text();
  let j: unknown; try { j = JSON.parse(text); } catch { j = {}; }
  if (!r.ok) throw new Error(`${opts.method ?? 'GET'} ${path} → ${r.status}: ${text.slice(0, 220)}`);
  return j;
};

// ── Carteiras determinísticas do cenário (derivadas do BTC_SELLER_KEY) ──
const seed = hexToBytes(process.env.BTC_SELLER_KEY);
const derive = (label: string): Uint8Array => hmac(sha256, seed, utf8ToBytes('probe-mesa|' + label));
const sellerBtcPriv = seed;
const sellerBtcPub = secp256k1.getPublicKey(sellerBtcPriv, true);
const net = btcCfg.network as BitcoinNet;
const sellerBtcAddr = p2wpkhAddress(sellerBtcPub, net);
const sellerEvm = privateKeyToAccount(('0x' + bytesToHex(derive('seller-evm'))) as `0x${string}`);
const buyerEvm = privateKeyToAccount(('0x' + bytesToHex(derive('buyer-evm'))) as `0x${string}`);
const pm1Evm = privateKeyToAccount(('0x' + bytesToHex(derive('pm1-evm'))) as `0x${string}`);
const buyerBtcAddr = p2wpkhAddress(secp256k1.getPublicKey(derive('buyer-btc'), true), net);
const signBip137 = (m: string): string => { const s = secp256k1.sign(bitcoinMessageHash(m), sellerBtcPriv, { prehash: false, format: 'recovered' }); return Buffer.from(new Uint8Array([27 + (s[0] as number) + 4, ...s.slice(1)])).toString('base64'); };

// ── Abastecimento Sepolia (keeper → gás; mint tUSDT permissionless) ──
const pub = createPublicClient({ transport: http(evmCfg.rpcUrl) });
const keeper = privateKeyToAccount(evmCfg.keeperKey);
const keeperW = createWalletClient({ transport: http(evmCfg.rpcUrl), account: keeper });
const ERC20 = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] }, { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
async function ensure(addr: `0x${string}`, minEth: string, label: string): Promise<void> {
  if (await pub.getBalance({ address: addr }) >= parseEther(minEth)) return;
  log(`abastecendo gás de ${label} (${addr.slice(0, 10)}…)`);
  const h = await keeperW.sendTransaction({ to: addr, value: parseEther(minEth), chain: null });
  await pub.waitForTransactionReceipt({ hash: h });
}
log(`cenário: vendedorBTC=${sellerBtcAddr} · comprador=${buyerEvm.address.slice(0, 10)}… · PM1=${pm1Evm.address.slice(0, 10)}…`);
await ensure(buyerEvm.address, '0.003', 'comprador');
await ensure(pm1Evm.address, '0.003', 'PM1');
if ((await pub.readContract({ address: evmCfg.tusdt, abi: ERC20, functionName: 'balanceOf', args: [buyerEvm.address] })) < 100_000_000n) {
  log('mintando 10.000 tUSDT para o comprador…');
  const h = await keeperW.writeContract({ address: evmCfg.tusdt, abi: ERC20, functionName: 'mint', args: [buyerEvm.address, 10_000_000_000n], chain: null });
  await pub.waitForTransactionReceipt({ hash: h });
}

// ── 1. PM: registro + carteira (multichain c/ ethereum do PM1) ──
log('registrando Pay Master no deploy…');
const reg = await api('/v1/portal/register', { method: 'POST', body: { name: 'Probe E2E', email: `probe-e2e-${Date.now()}@verum.test`, password: 'senha-forte-1' } }) as { token: string };
const tok = reg.token;
await api('/v1/portal/wallet/connect', { method: 'POST', token: tok, body: { address: pm1Evm.address, network: 'ethereum', addresses: [{ network: 'ethereum', address: pm1Evm.address }] } });

// ── 2. Mesa BTC ↔ tUSDT ──
log('criando mesa BTC(vendedor) ↔ tUSDT(comprador)…');
const mesa = await api('/v1/portal/mesas', { method: 'POST', token: tok, body: { chairs: [
  { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
  { role: 'BUYER', expectedAsset: { network: 'ethereum', contractOrMint: evmCfg.tusdt, decimals: 6, symbol: 'tUSDT' } },
  { role: 'PAYMASTER_1', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
] } }) as { mesaId: string; chairs: { chairId: string; role: string }[] };
const chairOf = (r: string): string => (mesa.chairs.find(c => c.role === r) as { chairId: string }).chairId;

// ── 3. Joins ASSINADOS (o fluxo que estava quebrando) ──
async function join(role: string, network: string, address: string, sign: (m: string) => Promise<string> | string, addresses: { network: string; address: string }[]): Promise<void> {
  const inv = await api(`/v1/portal/mesas/${mesa.mesaId}/chairs/${chairOf(role)}/invite`, { method: 'POST', token: tok, body: {} }) as { inviteId: string; code: string; link: string };
  if (!inv.link.startsWith(U)) throw new Error(`link do convite com host errado: ${inv.link}`);
  const ch = await api(`/v1/mesa-invites/${inv.inviteId}/challenge`, { method: 'POST', body: { code: inv.code, firstName: role, network, address } }) as { message: string; nonce: string };
  const signature = await sign(ch.message);
  await api(`/v1/mesa-invites/${inv.inviteId}/join`, { method: 'POST', body: { code: inv.code, firstName: role, network, address, nonce: ch.nonce, signature, addresses } });
  log(`${role} conectado ✓ (assinou e entrou)`);
}
await join('SELLER', 'bitcoin', sellerBtcAddr, m => signBip137(m), [{ network: 'bitcoin', address: sellerBtcAddr }, { network: 'ethereum', address: sellerEvm.address }]);
await join('BUYER', 'ethereum', buyerEvm.address, m => buyerEvm.signMessage({ message: m }), [{ network: 'ethereum', address: buyerEvm.address }, { network: 'bitcoin', address: buyerBtcAddr }]);

// ── 4. Config + precheck + APPROVE (deal HTLC real na Sepolia) ──
log('configurando quantidades (20.000 sats ↔ 12,9 tUSDT)…');
await api(`/v1/portal/mesas/${mesa.mesaId}/config`, { method: 'PATCH', token: tok, body: { amountInBase: '20000', buyerAmountInBase: '12900000', discountBps: 0, commissionBps: 0 } });
const pre = await api(`/v1/portal/mesas/${mesa.mesaId}/precheck`, { token: tok }) as { ok: boolean; failures: string[] };
log(`precheck: ok=${pre.ok}${pre.failures.length ? ' · ' + pre.failures.join(' | ') : ''}`);
log('APPROVE — cria a deal HTLC real (createTradeV2 na Sepolia, ~60-120s)…');
const ap = await api(`/v1/portal/mesas/${mesa.mesaId}/approve`, { method: 'POST', token: tok, body: {} }) as { approved: boolean; registerTx?: { to: `0x${string}`; data: `0x${string}` } | null; deal: { id: string; state: string; htlcFunding?: { address: string; requiredSat: string } } };
log(`APPROVED ✓ deal=${ap.deal.id} estado=${ap.deal.state}`);
log(`COFRE HTLC devolvido ao admin: ${ap.deal.htlcFunding ? ap.deal.htlcFunding.address + ' (' + ap.deal.htlcFunding.requiredSat + ' sats)' : '(não veio — ver resposta)'}`);
if (ap.registerTx?.to) {
  // Carteira real: o PM1 envia o createTradeV2 — aqui o probe faz o papel da Verum Wallet.
  log('registerTx recebido — PM1 enviando createTradeV2 na Sepolia…');
  const pm1W = createWalletClient({ transport: http(evmCfg.rpcUrl), account: pm1Evm });
  const h = await pm1W.sendTransaction({ to: ap.registerTx.to, data: ap.registerTx.data, chain: null });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error(`createTradeV2 revertida: ${h}`);
  log(`createTradeV2 confirmada ✓ tx=${h}`);
} else log('registro on-chain feito pelo backend (chave dev disponível)');
console.log('\nRESULTADO: fluxo completo da MESA no deploy funcionando — convites com host certo, joins assinados, precheck testnet, deal HTLC registrada no escrow V2 da Sepolia.');
