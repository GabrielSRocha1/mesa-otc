# ADR v5 — Habilitar moedas NATIVAS (não-BTC) e CROSS-CHAIN na mesa

> Complementa o ADR v4. Registra, com precisão, **o que falta** para o approve abrir assinaturas
> nesses dois casos — e **por que não é um ajuste de backend**, e sim trabalho on-chain no repo
> `verum-otc-onchain` (contratos/programas), com deploy + auditoria.

## Estado atual (o que JÁ funciona em produção)
- **BTC nativo (Vendedor) ↔ token EVM**: `HTLC_BTC` — swap atômico (BTC em HTLC P2WSH + token no escrow V2 com `htlcHash`). ✅
- **Token ↔ token na MESMA rede** (EVM/Solana/Tron): `ESCROW_DIRECT` — VerumOtcEscrow N/N (ADR v5 deste repo, `createMesaEscrowDirectDeal`). ✅
- Fundamento verificado no código:
  - Escrows EVM/Solana/Tron são **só-token** (recusam nativo): `verify` retorna "escrow Verum é só-token" quando `contractOrMint == null` (`src/adapters/verum/{evm,evmV2,solana,tron}.ts`).
  - **Hashlock** (preimage) existe SÓ no escrow EVM V2 (`htlcHash`). Solana/Tron `settle(..., _preimage)` ignoram a preimage → **não têm hashlock**.
  - Bitcoin tem HTLC nativo (P2WSH).

## Caso A — Moedas NATIVAS não-BTC (SOL, ETH, TRX)
**Por que não liga no backend:** o escrow só custodia token. Não há como o contrato segurar SOL/ETH/TRX nativos hoje.

**Opções (on-chain):**
1. **Escrow com depósito nativo** (mudança de contrato):
   - EVM: função `depositNative()` `payable` + contabilidade de saldo nativo por trade; `settle` transfere ETH.
   - Solana: o programa recebe **lamports** numa PDA (não só SPL); libera no settle.
   - Tron: `payable` TRX no contrato.
   - Custo: mudança de contrato + **auditoria** + redeploy em cada rede + atualização dos adapters (`verify`/`deposit`/`settle` aceitando nativo) + preço do nativo (já existe) + registro.
2. **Wrapped (atalho SEM mudar contrato)** — recomendado p/ curto prazo:
   - Usar **wSOL** (`So11111111111111111111111111111111111111112`) e **WETH**/**WTRX** como TOKEN no `ESCROW_DIRECT` que já funciona.
   - Backend: registrar os mints/contratos wrapped no `AssetRegistry` + preço (= preço do nativo) + allowlist anti-golpe (já deriva de `deps.registry`).
   - UX: a carteira precisa **embrulhar** nativo→wrapped antes de depositar (wSOL: `createSyncNative`; WETH: `deposit()`), e desembrulhar na ponta. Isso é trabalho na **Verum Wallet** (fluxo de wrap/unwrap), não no OTC.
   - Resultado: "vender SOL" = vender wSOL; o Vendedor embrulha, deposita, e o Comprador recebe wSOL (ou desembrulha para SOL).

**Recomendação:** curto prazo = **wrapped** (destrava SOL/ETH como token via `ESCROW_DIRECT`, dependendo do wrap/unwrap na carteira). Longo prazo = escrow nativo (opção 1), se o produto exigir nativo puro.

## Caso B — CROSS-CHAIN (redes diferentes, ambos token; ex.: USDT-Solana ↔ USDT-Ethereum)
**Por que não liga no backend:** swap atômico cross-chain exige **hashlock nos DOIS lados**. EVM V2 tem; **Solana e Tron NÃO têm**. Sem isso, não há liberação atômica (risco de um lado liberar e o outro não).

**Opções (on-chain):**
1. **HTLC generalizado** (recomendado, reaproveita o padrão BTC↔EVM):
   - Adicionar **hashlock/timelock ao programa Solana** e ao **contrato Tron** (campo `htlcHash` + `settle(preimage)` + refund por timelock), igual ao EVM V2.
   - Backend: generalizar `deriveSettlementPlan`/`createMesaHtlcDeal` para `HTLC` entre QUAISQUER duas redes (hoje a perna de contrato é travada em `ethereum`: `if (tokenNet !== 'ethereum') throw`).
   - Custo: mudança de programa/contrato (Solana/Tron) + auditoria + redeploy; wiring de backend relativamente pequeno depois.
2. **Bridge lock-and-message (CCIP)** — conforme ADR v4 §3:
   - `VerumSettlementRouter` por rede + lanes CCIP (EVM↔EVM) + relayer assinado p/ Tron.
   - Custo: maior (contratos de roteamento + integração CCIP + relayer).

**Recomendação:** **HTLC generalizado** (opção 1) — menor superfície, reaproveita o mecanismo já auditado do BTC↔EVM; o gargalo é adicionar hashlock ao programa Solana/Tron.

## O que ESTE repo (OTC backend) já deixou pronto para quando os contratos chegarem
- `deriveSettlementPlan` já classifica `HTLC_BTC` / `ESCROW_DIRECT` / `CROSS_CHAIN`.
- Approve roteia por plano; `CROSS_CHAIN` cai no caminho legado até o wiring on-chain existir.
- `createMesaHtlcDeal` é o molde para generalizar HTLC a outras redes (trocar a trava `ethereum`).
- Registro/anti-golpe/preço já consistentes por ambiente (ADR deste repo) — basta adicionar os
  tokens wrapped (Caso A, opção 2) para habilitar o atalho.

## Sequenciamento sugerido
1. **Wrapped tokens** (Caso A/2): registrar wSOL/WETH + preço + wrap/unwrap na Verum Wallet → "SOL/ETH" via `ESCROW_DIRECT`. *(menor esforço; parte no OTC, parte na wallet)*
2. **Hashlock Solana/Tron** (Caso B/1): habilita cross-chain atômico + BTC↔Solana/Tron. *(on-chain)*
3. **Escrow nativo** (Caso A/1) e/ou **CCIP** (Caso B/2): se o produto exigir nativo puro / lanes gerais. *(on-chain, maior)*
