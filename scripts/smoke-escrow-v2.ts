/** Smoke read-only do VerumOTCEscrowV2EVM na Sepolia: valida o ABI sincronizado e as views usadas pelo adapter. Uso: npx tsx scripts/smoke-escrow-v2.ts */
import { createPublicClient, http } from 'viem';
import ABI from '../src/onchain/router/abi/verumOtcEscrowV2.js';

const RPC = process.env.VERUM_EVM_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const ESCROW = (process.env.VERUM_EVM_V2_ESCROW_ADDRESS ?? '0x6362B1aFb1279214F58Fe8769049F078BACfC38F') as `0x${string}`;
const TUSDT = '0x7DFdcc43D60C12634E24044eCE13ed6b031B6743';

const pub = createPublicClient({ transport: http(RPC) });
const terms = {
  participants: [
    { wallet: '0x1111111111111111111111111111111111111111', role: 0 },
    { wallet: '0x2222222222222222222222222222222222222222', role: 3 },
  ],
  sellerAsset: '0x0000000000000000000000000000000000000000', sellerAmount: 75000000n,
  buyerAsset: TUSDT, buyerAmount: 1000000000n,
  platformFeeBps: 3, commissionBps: 0, discountBps: 0, slippageBps: 0,
  createdAt: 1791226800n, expiresAt: 1791229200n, termsVersion: 2, nonce: 1n,
  htlcHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
};
const read = (functionName: string, args: unknown[]) => pub.readContract({ address: ESCROW, abi: ABI as never, functionName, args });
console.log('escrow V2:', ESCROW);
console.log('hashTermsV2(perna externa 2 cadeiras):', String(await read('hashTermsV2', [terms])));
console.log('tUSDT ativo:', await read('isTokenActive', [TUSDT]));
console.log('TERMS_VERSION_V2:', await read('TERMS_VERSION_V2', []));
console.log('preimage de trade inexistente (esperado 0x):', await read('revealedPreimage', [('0x' + '0'.repeat(64)) as `0x${string}`]));
