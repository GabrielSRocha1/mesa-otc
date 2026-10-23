# Operar Indexado — preço indexado ao Verum Swap

Função **nova e aditiva**: além do preço **FIXED** (digitado pelo Pay Master 1, comportamento atual
intacto), a mesa pode ter o preço **INDEXED_VERUM_SWAP** — lido do agregador Verum Swap, com um
*spread* em bps definido pelo admin, e **congelado em quantidades exatas** (`fixing`) **antes de
qualquer assinatura**. O contrato on-chain **não muda**: ele sempre liquida valores fixos.

## Princípios (não negociáveis)
- **Aditivo**: nenhum fluxo existente (abrir mesa, convites, ordem Vendedor→PM1→PM2→Comprador, janelas
  de 1 h / 5 min, liberar assinaturas, executar transferências, fee de 0,03%) muda.
- **Off-chain, termina antes das assinaturas**: o fixing produz os valores concretos que os 4 assinam.
- **Matemática só com `bigint`** (sem `number`/float para preço/valor), respeitando `decimals`; ativos
  por rede/contrato|mint, nunca só símbolo.
- **Falha fechado**: sem índice confiável (≥ `minProviders` fontes, dispersão ≤ `maxDispersionBps`),
  não há fixing e a mesa **não avança**. Em produção sem `VERUM_SWAP_ENGINE_URL`, o modo fica
  **desligado** (a UI mostra o motivo); nunca simula preço.

## Ciclo
1. **Configurar** (`POST /v1/mesas/:mesaId/indexed-pricing`): admin escolhe `INDEXED_VERUM_SWAP`,
   o `spreadBps` e o valor-base (quantidade do Vendedor).
2. **Fixar** (`POST …/indexed-pricing/fix`): consulta o índice → **mediana** dos preços brutos (sem a
   fee de 0,075% do swap) → aplica o spread → calcula `quoteAmount` (floor + resíduo explícito) →
   grava `amountInBase`/`buyerAmountInBase` na config + registra o fixing versionado com `fixing_hash`.
3. **Ler** (`GET …/indexed-pricing`): os 4 participantes e o admin veem fontes, dispersão, valores e timer.
4. **Aprovar** (`/approve`): revalida o fixing (dentro da validade, config == fixing), **trava**
   (`LOCKED`, imutável) e injeta o `fixing_hash` + o `quoteAmount` fixado no deal.
5. **Remover** (`DELETE …/indexed-pricing`): volta a FIXED antes das assinaturas.

**Spread**: `priceFinalE18 = priceE18 · (10000 + spreadBps) / 10000`. Positivo = a favor do Vendedor.
**Quote**: `quoteAmount = ⌊ baseAmount · priceFinalE18 · 10^quoteDec / (1e18 · 10^baseDec) ⌋`, resíduo
registrado (mesma convenção de resíduo da grade — leftover explícito, nunca descartado em silêncio).

**Re-fixing / expiração**: refixar depois de aprovado reabre a mesa (`reopenForEdit` → **invalida as
assinaturas**) e cria uma **nova versão** dos termos. Se o novo preço divergir mais que `max_move_bps`,
exige confirmação explícita. Fixing expirado antes de `FULLY_SIGNED` bloqueia a aprovação até refixar.

## Vínculo com a assinatura (contrato intacto)
O `fixing_hash` entra em `terms.pricing.indexedFixingHash` → `pricingHash` → **`dealHash`** → envelope
assinado pelos 4 (off-chain). Em FIXED o campo é omitido (o `canonicalize` ignora `undefined`), então o
`dealHash` é **byte-idêntico** ao fluxo atual (regressão coberta por teste). O **on-chain `Terms` não
muda**: o vínculo concreto on-chain é a própria perna do Comprador (`quoteAmount`), que substitui o
`amountOut` do oráculo nos termos congelados.

## Pontos de integração (descobertos no repo, nada renomeado)
| Camada | Arquivo | Mudança (aditiva) |
|---|---|---|
| Erros | `src/domain/errors.ts` | códigos `INDEX_*` + `HTTP_STATUS` |
| Hash/termos | `src/domain/types.ts` | `Pricing.indexedFixingHash?`, `DealDraft.indexedFixingHash?/fixedAmountOutBase?` |
| Motor de deal | `src/engines/deal.ts` | `CreateDealInput` + congela `indexedFixingHash`/`fixedAmountOutBase` em `verifyInternal` |
| Módulo | `src/indexing/{types,math,provider,service}.ts` | **novo**: provider + matemática bigint + serviço de fixing |
| Config | `src/config.ts` | grupo `VERUM_SWAP_ENGINE_*` + `verumSwapEngineConfig()` |
| Persistência | `db/migrations/005_indexed_pricing.sql`, `src/db/{repository,sqlStore,memoryStore}.ts` | tabela `mesa_indexed_pricing` (1:1, versionada, imutável pós-LOCK) + métodos |
| API | `src/api/server.ts` | rotas `/v1/mesas/:mesaId/indexed-pricing*`, lock no `/approve`, thread no deal |
| Wiring | `src/app.ts` | provider real/mock + `IndexedPricingService` em `ApiDeps` |
| UI | `web/verum-dashboard.html` | toggle Fixo\|Indexado + card de fixing (fontes, dispersão, valores, timer, selo, avisos) |

## Migração e rollback
`db/migrations/005_indexed_pricing.sql` é **forward-only idempotente** (aplicada no boot por
`SqlStore.init`). Rollback **reversível** em `db/rollback/005_indexed_pricing.down.sql` — fica FORA de
`db/migrations/` de propósito (o runner executa todo `*.sql` daquela pasta); rode-o manualmente para
reverter. A tabela tem trigger `reject_locked_indexed_pricing` (imutável depois de `LOCKED`) e RLS
habilitado sem policies (acesso só pelo backend, como `deals`/`mesa_invites`).

## O que depende do Verum Swap Engine real
- `VerumSwapIndexProvider` chama `POST {VERUM_SWAP_ENGINE_URL}/api/swap/quote` esperando uma **lista de
  cotações** `{ provider, grossOut, quoteId?, expiresAt? }` (preço **bruto**, antes da fee do swap).
- Sem o grupo `VERUM_SWAP_ENGINE_*`: em **dev/testnet** usa `MockIndexProvider` (preço de dev, 2 fontes
  sintéticas); em **prod** o modo fica **desligado** (nunca simula).
- Variáveis em `.env.example` (`VERUM_SWAP_ENGINE_URL/KEY`, timeout, minProviders, dispersão, spread,
  max_move, TTL).

## Testes
`test/indexing.math.test.ts` (mediana 2/3/5, spread ±/0, resíduo, decimais 6/8/9/18, uint256),
`test/indexing.provider.test.ts` (minProviders, dispersão, sem rota, timeout/500/JSON inválido),
`test/indexing.service.test.ts` (configurar/fixar/refixar+versão, expiração, max_move, lock, hash),
`test/indexing.api.test.ts` (e2e: fixing entra no deal assinado; só o PM1 escreve; FIXED idêntico).
