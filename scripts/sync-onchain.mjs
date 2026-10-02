/**
 * Vendoriza os packages do repo verum-otc-onchain em src/onchain/ (fonte canônica dos
 * contratos de escrow EVM/Tron/Solana). Reexecutável: sobrescreve tudo em src/onchain.
 *
 * Reescritas aplicadas (o repo de origem usa noble v1 / zod v3 / workspaces):
 *  - "@verum-otc/<pkg>"            → caminho relativo dentro de src/onchain
 *  - "@noble/hashes/sha256"        → "@noble/hashes/sha2.js" (noble v2)
 *  - z.nativeEnum(                 → z.enum(                 (zod v4)
 *  - imports de .json com atributo → módulos .ts gerados (evita bundling de JSON no Vercel)
 *
 * Uso: node scripts/sync-onchain.mjs [caminho-do-repo-onchain]
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const SRC = process.argv[2] ?? "C:/Users/gabri/Downloads/verum-otc-onchain/verum-otc-onchain";
const DST = path.resolve("src/onchain");

const HEADER = (rel) => `// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/${rel}\n// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.\n`;

/** depth = nº de níveis abaixo de src/onchain (1 = core/, 2 = router/adapters/) */
function rewrite(code, depth) {
  const up = "../".repeat(depth);
  return code
    .replaceAll('from "@verum-otc/types"', `from "${up}types.js"`)
    .replaceAll('from "@verum-otc/core"', `from "${up}core/index.js"`)
    .replaceAll('from "@verum-otc/crypto"', `from "${up}crypto/index.js"`)
    .replaceAll('from "@verum-otc/registry"', `from "${up}registry/index.js"`)
    .replaceAll('from "@noble/hashes/sha256"', 'from "@noble/hashes/sha2.js"')
    .replaceAll("z.nativeEnum(", "z.enum(")
    .replaceAll('from "./registry.json" with { type: "json" }', 'from "./registryData.js"')
    .replaceAll('from "../abi/VerumOTCEscrow.abi.json" with { type: "json" }', 'from "../abi/verumOtcEscrowEvm.js"')
    .replaceAll('from "../abi/VerumOTCEscrowTron.abi.json" with { type: "json" }', 'from "../abi/verumOtcEscrowTron.js"');
}

function copyTs(srcRel, dstRel, depth) {
  const code = readFileSync(path.join(SRC, srcRel), "utf8");
  const out = path.join(DST, dstRel);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, HEADER(srcRel) + rewrite(code, depth));
}

function jsonToTs(srcRel, dstRel) {
  const data = JSON.parse(readFileSync(path.join(SRC, srcRel), "utf8"));
  const out = path.join(DST, dstRel);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, HEADER(srcRel) + `export default ${JSON.stringify(data, null, 2)};\n`);
}

rmSync(DST, { recursive: true, force: true });

// types
copyTs("packages/types/src/index.ts", "types.ts", 0);
// core / crypto / registry (todos os .ts do diretório)
for (const pkg of ["core", "crypto", "registry"]) {
  for (const f of readdirSync(path.join(SRC, `packages/${pkg}/src`)).filter((f) => f.endsWith(".ts"))) {
    copyTs(`packages/${pkg}/src/${f}`, `${pkg}/${f}`, 1);
  }
}
jsonToTs("packages/registry/src/registry.json", "registry/registryData.ts");
jsonToTs("packages/registry/src/registry.testnet.json", "registry/registryTestnetData.ts");
// router: só a interface ChainAdapter e os adapters reais (OtcRouter/store/indexer/simulated ficam fora:
// o DealEngine/SettlementEngine do mesa é o orquestrador)
copyTs("packages/router/src/types.ts", "router/types.ts", 1);
for (const f of ["evm.ts", "tron.ts", "solana.ts"]) copyTs(`packages/router/src/adapters/${f}`, `router/adapters/${f}`, 2);
jsonToTs("packages/router/src/abi/VerumOTCEscrow.abi.json", "router/abi/verumOtcEscrowEvm.ts");
jsonToTs("packages/router/src/abi/VerumOTCEscrowTron.abi.json", "router/abi/verumOtcEscrowTron.ts");

console.log(`src/onchain sincronizado a partir de ${SRC}`);
