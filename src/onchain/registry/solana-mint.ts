// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/registry/src/solana-mint.ts
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
/**
 * Validação de mint Solana SEM confiar em metadata: lê o layout bruto da conta.
 *  - owner deve ser Token Program ou Token-2022
 *  - decimals devem bater com o registry
 *  - freeze authority é registrada; aceita apenas com flag administrativa explícita
 *  - Token-2022: extensões perigosas são rejeitadas por padrão
 */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export enum ExtensionType {
  Uninitialized = 0, TransferFeeConfig = 1, TransferFeeAmount = 2, MintCloseAuthority = 3,
  ConfidentialTransferMint = 4, ConfidentialTransferAccount = 5, DefaultAccountState = 6, ImmutableOwner = 7,
  MemoTransfer = 8, NonTransferable = 9, InterestBearingConfig = 10, CpiGuard = 11, PermanentDelegate = 12,
  NonTransferableAccount = 13, TransferHook = 14, TransferHookAccount = 15, ConfidentialTransferFeeConfig = 16,
  ConfidentialTransferFeeAmount = 17, MetadataPointer = 18, TokenMetadata = 19, GroupPointer = 20, TokenGroup = 21,
  GroupMemberPointer = 22, TokenGroupMember = 23, ConfidentialMintBurn = 24, ScaledUiAmount = 25, Pausable = 26,
}

/** Extensões incompatíveis com o modelo de escrow (um terceiro pode mover/bloquear/taxar fundos em custódia). */
export const DANGEROUS_EXTENSIONS: ReadonlySet<ExtensionType> = new Set([
  ExtensionType.TransferFeeConfig, ExtensionType.PermanentDelegate, ExtensionType.TransferHook,
  ExtensionType.NonTransferable, ExtensionType.DefaultAccountState, ExtensionType.ConfidentialTransferMint,
  ExtensionType.ConfidentialTransferFeeConfig, ExtensionType.ConfidentialMintBurn, ExtensionType.Pausable,
  ExtensionType.MintCloseAuthority, ExtensionType.InterestBearingConfig, ExtensionType.ScaledUiAmount,
]);

export interface MintAccountRaw { owner: string; data: Uint8Array }

export interface MintAnalysis {
  tokenProgram: "TOKEN" | "TOKEN_2022";
  decimals: number;
  isInitialized: boolean;
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  extensions: ExtensionType[];
  dangerousExtensions: ExtensionType[];
}

const MINT_BASE_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165; // base(82) + padding até 165, depois 1 byte AccountType
const ACCOUNT_TYPE_MINT = 1;

export function analyzeMint(raw: MintAccountRaw): MintAnalysis {
  const { owner, data } = raw;
  let tokenProgram: "TOKEN" | "TOKEN_2022";
  if (owner === TOKEN_PROGRAM_ID) tokenProgram = "TOKEN";
  else if (owner === TOKEN_2022_PROGRAM_ID) tokenProgram = "TOKEN_2022";
  else throw new Error(`conta não pertence a um token program conhecido: ${owner}`);
  if (data.length < MINT_BASE_LEN) throw new Error("conta de mint menor que 82 bytes");

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mintAuthOption = dv.getUint32(0, true);
  const decimals = data[44]!;
  const isInitialized = data[45] === 1;
  const freezeAuthOption = dv.getUint32(46, true);

  const extensions: ExtensionType[] = [];
  if (tokenProgram === "TOKEN_2022" && data.length > ACCOUNT_TYPE_OFFSET) {
    if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) throw new Error("account type Token-2022 não é Mint");
    let off = ACCOUNT_TYPE_OFFSET + 1;
    while (off + 4 <= data.length) {
      const type = dv.getUint16(off, true);
      const len = dv.getUint16(off + 2, true);
      if (type === ExtensionType.Uninitialized) break;
      extensions.push(type as ExtensionType);
      off += 4 + len;
    }
  }
  return {
    tokenProgram, decimals, isInitialized,
    hasMintAuthority: mintAuthOption === 1,
    hasFreezeAuthority: freezeAuthOption === 1,
    extensions,
    dangerousExtensions: extensions.filter((e) => DANGEROUS_EXTENSIONS.has(e)),
  };
}

export interface MintPolicy { expectedDecimals: number; expectedProgram: "TOKEN" | "TOKEN_2022"; allowFreezeAuthority: boolean }

export type MintVerdict = { accepted: true; analysis: MintAnalysis } | { accepted: false; reason: string; analysis?: MintAnalysis };

/** TOKEN NÃO AUTORIZADO = REJEITADO. Nome/símbolo/logo nunca entram aqui. */
export function validateSolanaMint(raw: MintAccountRaw, policy: MintPolicy): MintVerdict {
  let analysis: MintAnalysis;
  try { analysis = analyzeMint(raw); } catch (e) { return { accepted: false, reason: (e as Error).message }; }
  if (!analysis.isInitialized) return { accepted: false, reason: "mint não inicializado", analysis };
  if (analysis.tokenProgram !== policy.expectedProgram) {
    return { accepted: false, reason: `token program ${analysis.tokenProgram} ≠ esperado ${policy.expectedProgram}`, analysis };
  }
  if (analysis.decimals !== policy.expectedDecimals) {
    return { accepted: false, reason: `decimals ${analysis.decimals} ≠ esperado ${policy.expectedDecimals}`, analysis };
  }
  if (analysis.hasFreezeAuthority && !policy.allowFreezeAuthority) {
    return { accepted: false, reason: "freeze authority presente sem autorização administrativa explícita", analysis };
  }
  if (analysis.dangerousExtensions.length) {
    return { accepted: false, reason: `extensões Token-2022 perigosas: ${analysis.dangerousExtensions.map((e) => ExtensionType[e]).join(", ")}`, analysis };
  }
  return { accepted: true, analysis };
}
