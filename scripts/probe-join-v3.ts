/**
 * Probe do fluxo V3 do CONVITE exatamente como a página envia (web/verum-convite.html v3Connect):
 * network:'solana' fixo, endereço base58, assinatura ed25519 em bs58, addresses multichain.
 * Prova que o lado SERVIDOR do caminho real está verde — isola problemas de formato da wallet.
 *
 * Uso: npx tsx scripts/probe-join-v3.ts [url]
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const U = process.argv[2] ?? 'https://otcdesk.verumcrypto.com';
const log = (m: string): void => console.log('▸ ' + m);
const api = async (path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<any> => {
  const r = await fetch(U + path, { method: opts.method ?? 'GET', headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.method ?? 'GET'} ${path} → ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
};

// PM admin + mesa com cadeira de vendedor BTC (mesma forma do dashboard).
const reg = await api('/v1/portal/register', { method: 'POST', body: { name: 'ProbeV3', email: `probe-v3-${Date.now()}@verum.test`, password: 'senha-forte-1' } });
const tok = reg.token as string;
await api('/v1/portal/wallet/connect', { method: 'POST', token: tok, body: { address: '7'.repeat(44), network: 'solana', addresses: [{ network: 'solana', address: '7'.repeat(44) }] } });
const mesa = await api('/v1/portal/mesas', { method: 'POST', token: tok, body: { chairs: [
  { role: 'SELLER', expectedAsset: { network: 'bitcoin', contractOrMint: null, decimals: 8, symbol: 'BTC' } },
  { role: 'BUYER', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
  { role: 'PAYMASTER_1', expectedAsset: { network: 'ethereum', contractOrMint: null, decimals: 18, symbol: 'ETH' } },
] } });
const seller = mesa.chairs.find((c: { role: string }) => c.role === 'SELLER');
const inv = await api(`/v1/portal/mesas/${mesa.mesaId}/chairs/${seller.chairId}/invite`, { method: 'POST', token: tok, body: {} });
log(`convite criado · code=${inv.code}`);

// ── Conexão EXATAMENTE como a página: solana fixo + ed25519 + bs58 ──
const kp = nacl.sign.keyPair();
const address = bs58.encode(kp.publicKey);
const addresses = [
  { network: 'solana', address },
  { network: 'bitcoin', address: 'tb1q' + 'x'.repeat(38) },
  { network: 'ethereum', address: '0x' + 'a'.repeat(40) },
];
// Caminho REAL da Verum Wallet no dapp-browser: /connect (prova = conexão, SEM assinatura).
const join = await api(`/v1/mesa-invites/${inv.inviteId}/connect`, { method: 'POST', body: { code: inv.code, firstName: 'ProbeV3', network: 'solana', address, addresses } });
log(`CONNECT V3 OK ✓ mesaId=${join.mesaId} role=${join.role} (token de participante emitido)`);

// Variantes que a tolerância do backend deve aceitar sem derrubar a requisição:
const inv2 = await api(`/v1/portal/mesas/${mesa.mesaId}/chairs/${mesa.chairs.find((c: { role: string }) => c.role === 'BUYER').chairId}/invite`, { method: 'POST', token: tok, body: {} });
const kp2 = nacl.sign.keyPair();
const addr2 = bs58.encode(kp2.publicKey);
const join2 = await api(`/v1/mesa-invites/${inv2.inviteId}/connect`, { method: 'POST', body: { code: inv2.code, firstName: 'ProbeVb', network: 'solana', address: addr2, addresses: null } });
log(`CONNECT com addresses:null aceito ✓ (${join2.role})`);
console.log('\nRESULTADO: caminho V3 do convite (conexão Verum, sem assinatura) verde no servidor.');
