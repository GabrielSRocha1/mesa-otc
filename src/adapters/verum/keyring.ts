/**
 * Keyrings DEV/DEMO para o escrow canônico (NUNCA em produção): EOAs secp256k1 determinísticas
 * por dono de slot da mesa (mesma derivação 'evm-dev|' do EvmDevKeyring legado — endereços
 * idênticos aos já semeados) e variante Tron (mesma chave ⇒ mesmos 20 bytes; endereço T... via
 * base58check 0x41). Em produção os participantes assinam nas próprias carteiras.
 */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { tronAddressFromPubkey } from '../../engines/signature.js';

type Hex = `0x${string}`;

abstract class DevSecpKeyring {
  private byOwner = new Map<string, { priv: Hex; account: PrivateKeyAccount; address: string }>();
  private byAddress = new Map<string, { priv: Hex; account: PrivateKeyAccount; address: string }>();
  constructor(private readonly masterSecret: string, private readonly label: string) {}
  protected abstract deriveAddress(priv: Hex, account: PrivateKeyAccount): string;
  private entry(owner: string) {
    let e = this.byOwner.get(owner);
    if (!e) {
      const priv = ('0x' + bytesToHex(hmac(sha256, hexToBytes(this.masterSecret), utf8ToBytes(this.label + '|' + owner)))) as Hex;
      const account = privateKeyToAccount(priv);
      e = { priv, account, address: this.deriveAddress(priv, account) };
      this.byOwner.set(owner, e); this.byAddress.set(e.address.toLowerCase(), e);
    }
    return e;
  }
  addressFor(owner: string): string { return this.entry(owner).address; }
  accountFor(owner: string): PrivateKeyAccount { return this.entry(owner).account; }
  privateKeyFor(owner: string): Hex { return this.entry(owner).priv; }
  privateKeyByAddress(address: string): Hex | null { return this.byAddress.get(address.toLowerCase())?.priv ?? null; }
  accountByAddress(address: string): PrivateKeyAccount | null { return this.byAddress.get(address.toLowerCase())?.account ?? null; }
}

/** EOAs EVM dev (derivação idêntica ao EvmDevKeyring legado: 'evm-dev|'+owner). */
export class VerumEvmDevKeyring extends DevSecpKeyring {
  constructor(masterSecret: string) { super(masterSecret, 'evm-dev'); }
  protected deriveAddress(_priv: Hex, account: PrivateKeyAccount): string { return account.address; }
}

/** Carteiras Tron dev: mesma curva; endereço T... = base58check(0x41 ‖ keccak(pub)[12..]). */
export class TronDevKeyring extends DevSecpKeyring {
  constructor(masterSecret: string) { super(masterSecret, 'tron-dev'); }
  protected deriveAddress(priv: Hex, _account: PrivateKeyAccount): string {
    return tronAddressFromPubkey(secp256k1.getPublicKey(hexToBytes(priv.slice(2)), false));
  }
}
