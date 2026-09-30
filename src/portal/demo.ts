/**
 * Mesa DEMO — carteiras falsas para apresentação (nunca em produção).
 * 4 keypairs Ed25519 determinísticas (uma por papel) derivadas do segredo mestre; o endereço Solana
 * é real (base58 do pubkey) e ASSINA de verdade os turnos da esteira — todas as validações do
 * DealEngine permanecem. Endereços "multichain" (ETH/BTC) são apenas cosméticos: os saldos deles
 * vêm da tabela canned abaixo, nunca de RPC; nada aqui toca uma blockchain.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { getChain } from '../chains/registry.js';

export type DemoRole = 'PAYMASTER_1' | 'SELLER' | 'BUYER' | 'PAYMASTER_2';
export const DEMO_ROLES: DemoRole[] = ['PAYMASTER_1', 'SELLER', 'BUYER', 'PAYMASTER_2'];

/** Preços estáticos (USD) p/ demo — a apresentação não depende do CoinGecko. BRL = USD × 5.4. */
export const DEMO_PRICES_USD: Record<string, number> = {
  bitcoin: 64_230.5, ethereum: 2_418.75, solana: 151.2, bsc: 565.4, polygon: 0.52, tron: 0.16,
  arbitrum: 2_418.75, base: 2_418.75, avalanche: 28.4, cronos: 0.09, optimism: 2_418.75,
  xrp: 0.62, zcash: 38.5, ton: 5.9, aptos: 8.1, near: 4.6, algorand: 0.17, stellar: 0.11,
};
export const DEMO_BRL_RATE = 5.4;

/** Portfólio canned por papel (rede nativa → quantidade) + USDT na Solana. */
const DEMO_PORTFOLIO: Record<DemoRole, { native: Record<string, number>; usdtSol: number }> = {
  PAYMASTER_1: { native: { solana: 5_400, bitcoin: 1.2, ethereum: 18.5 }, usdtSol: 250_000 },
  SELLER: { native: { solana: 1_850, bitcoin: 12.4, ethereum: 6.2 }, usdtSol: 2_100_000 },
  BUYER: { native: { solana: 320, bitcoin: 0.8, ethereum: 96 }, usdtSol: 840_000 },
  PAYMASTER_2: { native: { solana: 2_150, bitcoin: 0.35, ethereum: 9.1 }, usdtSol: 120_000 },
};

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export class DemoMesaKeyring {
  private kps = new Map<DemoRole, nacl.SignKeyPair>();
  /** address (qualquer rede fake) → { role, network } */
  private index = new Map<string, { role: DemoRole; network: string }>();
  constructor(private readonly masterSecret: string) {
    for (const role of DEMO_ROLES) for (const a of this.addressesFor(role)) this.index.set(a.address, { role, network: a.network });
  }
  private kp(role: DemoRole): nacl.SignKeyPair {
    let k = this.kps.get(role);
    if (!k) { const seed = hmac(sha256, hexToBytes(this.masterSecret), utf8ToBytes('demo-mesa|' + role)); k = nacl.sign.keyPair.fromSeed(seed); this.kps.set(role, k); }
    return k;
  }
  /** Endereço Solana REAL do papel (pubkey da keypair que assina os turnos). */
  addressFor(role: DemoRole): string { return bs58.encode(this.kp(role).publicKey); }
  /** Assinatura Ed25519 (base58) da mensagem do envelope — igual à Verum Wallet. */
  signMessage(role: DemoRole, message: string): string { return bs58.encode(nacl.sign.detached(utf8ToBytes(message), this.kp(role).secretKey)); }
  /** Endereços multichain de exibição (solana real + ETH/BTC derivados, só cosméticos). */
  addressesFor(role: DemoRole): { network: string; address: string }[] {
    const h = bytesToHex(sha256(utf8ToBytes('demo-addr|' + role + '|' + this.addressFor(role))));
    const eth = '0x' + h.slice(0, 40);
    let btc = 'bc1q'; for (let i = 0; i < 38; i++) btc += BECH32[parseInt(h.slice(i, i + 2), 16) % 32];
    return [
      { network: 'solana', address: this.addressFor(role) },
      { network: 'ethereum', address: eth },
      { network: 'bitcoin', address: btc },
    ];
  }
  roleOf(address: string): { role: DemoRole; network: string } | null { return this.index.get(address) ?? null; }
  allAddresses(): Set<string> { return new Set(this.index.keys()); }
}

/** Resposta canned no formato exato de POST /v1/chains/balances. */
export function demoBalancesResponse(keyring: DemoMesaKeyring, addresses: { network: string; address: string }[]): { items: unknown[]; totalUsd: number; totalBrl: number } {
  let totalUsd = 0, totalBrl = 0;
  const items = addresses.map(({ network, address }) => {
    const chain = getChain(network);
    const who = keyring.roleOf(address);
    if (!chain || !who) return { network, address, supported: false as const };
    const pf = DEMO_PORTFOLIO[who.role];
    const amount = pf.native[chain.chainKey] ?? 0;
    const usd = DEMO_PRICES_USD[chain.chainKey] ?? null;
    const valueUsd = usd != null ? amount * usd : null;
    const valueBrl = valueUsd != null ? valueUsd * DEMO_BRL_RATE : null;
    const tokens = chain.chainKey === 'solana' && pf.usdtSol > 0 ? [{
      symbol: 'USDT', contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, amount: pf.usdtSol,
      icon: '/v1/chains/icon/tether', priceUsd: 1.0, priceBrl: DEMO_BRL_RATE,
      valueUsd: pf.usdtSol, valueBrl: pf.usdtSol * DEMO_BRL_RATE,
    }] : [];
    totalUsd += (valueUsd ?? 0) + tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0);
    totalBrl += (valueBrl ?? 0) + tokens.reduce((s, t) => s + (t.valueBrl ?? 0), 0);
    return {
      network: chain.chainKey, displayName: chain.displayName, address, supported: true as const,
      symbol: chain.nativeSymbol, decimals: chain.nativeDecimals, explorer: chain.explorer,
      icon: '/v1/chains/icon/' + chain.coingeckoId, ok: true as const, amount,
      raw: String(Math.round(amount * 10 ** chain.nativeDecimals)),
      priceUsd: usd, priceBrl: usd != null ? usd * DEMO_BRL_RATE : null, valueUsd, valueBrl, tokens,
    };
  });
  return { items, totalUsd, totalBrl };
}
