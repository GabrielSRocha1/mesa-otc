/** Probe do /v1/auth no deploy: challenge → assinatura ed25519 correta → verify. Mostra o corpo do erro. */
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const U = process.argv[2] ?? 'https://otcdesk.verumcrypto.com';
const kp = nacl.sign.keyPair();
const address = bs58.encode(kp.publicKey);
const ch = await (await fetch(`${U}/v1/auth/challenge?network=solana&address=${address}`)).json() as { nonce: string; message: string; issuedAtIso?: string; expiresAtIso?: string };
console.log('challenge ok · nonce', String(ch.nonce).slice(0, 10) + '…');
const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(ch.message), kp.secretKey));
await new Promise(r => setTimeout(r, 1500)); // atravessa invocações serverless
const res = await fetch(`${U}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'solana', address, nonce: ch.nonce, signature, issuedAt: ch.issuedAtIso, expiresAt: ch.expiresAtIso }) });
console.log('verify →', res.status, (await res.text()).slice(0, 300));
