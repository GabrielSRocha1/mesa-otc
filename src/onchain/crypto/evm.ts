// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/crypto/src/evm.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * Hashing EIP-712 idêntico ao contrato VerumOTCEscrowBase.sol (EVM e Tron).
 * Vetores de teste cruzados com o Foundry garantem equivalência byte a byte.
 */
import {
  encodeAbiParameters, hashTypedData, keccak256, toHex, type Hex, parseAbiParameters, concatHex, isAddress, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Role, type Terms, type Signature, type WalletAttestation } from "../types.js";

export const EIP712_NAME = "VerumOTC";
export const EIP712_VERSION = "1";

export const TERMS_TYPEHASH = keccak256(
  toHex(
    "Terms(address seller,address buyer,address paymaster01,address paymaster02,address sellerAsset,uint256 sellerAmount,address buyerAsset,uint256 buyerAmount,uint16 platformFeeBps,uint16 commissionBps,uint16 discountBps,uint16 slippageBps,uint64 createdAt,uint64 expiresAt,uint32 termsVersion,uint256 nonce)",
  ),
);

export const APPROVAL_TYPES = {
  Approval: [
    { name: "tradeId", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "role", type: "uint8" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const ATTESTATION_TYPES = {
  WalletAttestation: [
    { name: "wallet", type: "address" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export function evmDomain(chainId: number, verifyingContract: Hex) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId: BigInt(chainId), verifyingContract } as const;
}

const addr = (a: string): Hex => {
  if (!isAddress(a)) throw new Error(`endereço EVM inválido: ${a}`);
  return getAddress(a);
};

/** hashStruct(Terms) — função pura dos termos (não depende do contrato). */
export function hashTermsEvm(t: Terms): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, address, address, address, address, address, uint256, address, uint256, uint16, uint16, uint16, uint16, uint64, uint64, uint32, uint256",
      ),
      [
        TERMS_TYPEHASH, addr(t.seller), addr(t.buyer), addr(t.paymaster01), addr(t.paymaster02), addr(t.sellerAsset),
        t.sellerAmount, addr(t.buyerAsset), t.buyerAmount, t.platformFeeBps, t.commissionBps, t.discountBps,
        t.slippageBps, BigInt(t.createdAt), BigInt(t.expiresAt), t.termsVersion, t.nonce,
      ],
    ),
  );
}

/** tradeId = keccak256(abi.encode(chainId, escrow, termsHash)). */
export function computeTradeIdEvm(chainId: number, escrow: string, termsHash: Hex): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("uint256, address, bytes32"), [BigInt(chainId), addr(escrow), termsHash]));
}

export function approvalDigestEvm(chainId: number, escrow: string, tradeId: Hex, termsHash: Hex, role: Role, deadline: number): Hex {
  return hashTypedData({
    domain: evmDomain(chainId, addr(escrow)),
    types: APPROVAL_TYPES,
    primaryType: "Approval",
    message: { tradeId, termsHash, role, deadline: BigInt(deadline) },
  });
}

export function attestationDigestEvm(chainId: number, escrow: string, wallet: string, validUntil: number): Hex {
  return hashTypedData({
    domain: evmDomain(chainId, addr(escrow)),
    types: ATTESTATION_TYPES,
    primaryType: "WalletAttestation",
    message: { wallet: addr(wallet), validUntil: BigInt(validUntil) },
  });
}

/** Assina a aprovação de um papel (uso em testes, relayers de Paymaster e SDK da Verum Wallet). */
export async function signApprovalEvm(
  privateKey: Hex, chainId: number, escrow: string, tradeId: Hex, termsHash: Hex, role: Role, deadline: number,
): Promise<Signature> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({
    domain: evmDomain(chainId, addr(escrow)),
    types: APPROVAL_TYPES,
    primaryType: "Approval",
    message: { tradeId, termsHash, role, deadline: BigInt(deadline) },
  });
  return { role, signer: account.address, tradeId, termsHash, deadline, signature };
}

/** Atestado Verum Wallet: emitido pelo serviço de onboarding com a chave `attestor`. */
export async function signWalletAttestationEvm(
  attestorPrivateKey: Hex, chainId: number, escrow: string, wallet: string, validUntil: number,
): Promise<WalletAttestation> {
  const account = privateKeyToAccount(attestorPrivateKey);
  const signature = await account.signTypedData({
    domain: evmDomain(chainId, addr(escrow)),
    types: ATTESTATION_TYPES,
    primaryType: "WalletAttestation",
    message: { wallet: addr(wallet), validUntil: BigInt(validUntil) },
  });
  return { wallet: addr(wallet), validUntil, signature };
}

export { concatHex };
