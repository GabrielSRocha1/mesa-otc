/**
 * Wallet integration — autenticação por prova de controle da carteira (ADR-011).
 * Fluxo: challenge (nonce de uso único) → carteira assina → verify → sessão. Nunca recebe seed/chave privada;
 * o servidor só guarda o segredo HMAC da sessão (injetado por configuração, nunca no código).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyMessage } from 'viem';
import { NETWORK_KEY_SCHEME, type Environment, type KeyScheme, type Network } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../db/repository.js';
import type { AdapterRegistry } from '../adapters/types.js';
import { verifyBitcoin, verifySolana } from '../engines/signature.js';

export interface Session { sub: string; network: Network; chainId: string; address: string; keyScheme: KeyScheme; role: 'participant' | 'operator'; iat: number; exp: number }
export interface Challenge { message: string; nonce: string; expiresAt: number }

const b64u = (s: string | Buffer): string => Buffer.from(s).toString('base64url');
const fromB64u = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

export class WalletAuth {
  constructor(private readonly store: Store, private readonly adapters: AdapterRegistry, private readonly cfg: { env: Environment; sessionSecret: string; sessionTtlMs: number; challengeTtlMs: number; operators: Set<string>; appDomain: string }, private readonly now: () => number = () => Date.now()) {
    if (cfg.sessionSecret.length < 32) throw new Error('sessionSecret precisa ter ao menos 32 caracteres');
  }

  async challenge(network: Network, address: string): Promise<Challenge> {
    const a = this.adapters.get(network); if (!a) throw new DomainError('ADAPTER_UNAVAILABLE', `Rede ${network} não suportada`);
    if (!a.validateAddress(address)) throw new DomainError('WALLET_INVALID', 'Endereço inválido para a rede');
    const nonce = randomToken(); const expiresAt = this.now() + this.cfg.challengeTtlMs;
    await this.store.insertNonce({ value: nonce, kind: 'challenge', dealId: null, revision: null, role: null, subject: `${network}:${address.toLowerCase()}`, issuedAt: this.now(), expiresAt, consumedAt: null });
    const message = [`${this.cfg.appDomain} quer que você entre com sua carteira ${network}.`, '', `Endereço: ${address}`, `Domínio: VerumOTC/1/${this.cfg.env}`, `Nonce: ${nonce}`, `Emitido em: ${new Date(this.now()).toISOString()}`, `Expira em: ${new Date(expiresAt).toISOString()}`, '', 'Assinar esta mensagem não movimenta fundos e não concede permissões.'].join('\n');
    return { message, nonce, expiresAt };
  }

  /** Reconstrói a mensagem a partir do nonce persistido — o cliente não escolhe o que assina. */
  async verify(network: Network, address: string, nonce: string, signature: string, issuedAtIso: string, expiresAtIso: string): Promise<{ token: string; session: Session }> {
    const n = await this.store.getNonce(nonce);
    if (!n || n.kind !== 'challenge') throw new DomainError('NONCE_INVALID', 'desafio desconhecido');
    if (n.subject !== `${network}:${address.toLowerCase()}`) throw new DomainError('NONCE_INVALID', 'desafio emitido para outra carteira');
    if (n.consumedAt !== null) throw new DomainError('NONCE_INVALID', 'desafio já utilizado');
    if (this.now() >= n.expiresAt) throw new DomainError('SIGNATURE_EXPIRED', 'desafio expirado');
    if (new Date(issuedAtIso).getTime() !== n.issuedAt || new Date(expiresAtIso).getTime() !== n.expiresAt) throw new DomainError('SIGNATURE_INVALID', 'carimbos do desafio não conferem');
    const message = [`${this.cfg.appDomain} quer que você entre com sua carteira ${network}.`, '', `Endereço: ${address}`, `Domínio: VerumOTC/1/${this.cfg.env}`, `Nonce: ${nonce}`, `Emitido em: ${issuedAtIso}`, `Expira em: ${expiresAtIso}`, '', 'Assinar esta mensagem não movimenta fundos e não concede permissões.'].join('\n');
    let ok: boolean;
    if (network === 'ethereum') { try { ok = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` }); } catch { ok = false; } }
    else if (network === 'solana') ok = verifySolana(message, signature, address);
    else ok = verifyBitcoin(message, signature, address);
    if (!ok) throw new DomainError('SIGNATURE_INVALID', 'assinatura do desafio inválida para o endereço informado');
    if (!(await this.store.consumeNonce(nonce, this.now()))) throw new DomainError('NONCE_INVALID', 'desafio já utilizado');
    const a = this.adapters.get(network)!;
    const session: Session = { sub: `${network}:${address}`, network, chainId: a.chain.chainId, address, keyScheme: NETWORK_KEY_SCHEME[network], role: this.cfg.operators.has(address.toLowerCase()) ? 'operator' : 'participant', iat: this.now(), exp: this.now() + this.cfg.sessionTtlMs };
    return { token: this.sign(session), session };
  }

  sign(session: Session): string { const body = b64u(JSON.stringify(session)); const mac = createHmac('sha256', this.cfg.sessionSecret).update(body).digest('base64url'); return `${body}.${mac}`; }
  parse(token: string | undefined): Session | null {
    if (!token) return null; const [body, mac] = token.split('.'); if (!body || !mac) return null;
    const expected = createHmac('sha256', this.cfg.sessionSecret).update(body).digest('base64url');
    const a = Buffer.from(mac), b = Buffer.from(expected); if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try { const s = JSON.parse(fromB64u(body)) as Session; if (typeof s.exp !== 'number' || s.exp <= this.now()) return null; return s; } catch { return null; }
  }
}
export function randomToken(bytes = 16): string { const arr = new Uint8Array(bytes); globalThis.crypto.getRandomValues(arr); return Buffer.from(arr).toString('hex'); }
