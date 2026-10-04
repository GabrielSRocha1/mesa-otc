# CHANGELOG — VERUM OTC v3: mesas multi-instância, cadeiras + convites, conexão com prova de posse

## Resumo

O Pay Master agora cria **N mesas simultâneas** com 3–4 cadeiras **sem cadastrar wallet de ninguém**. Cada cadeira recebe um convite único (link + código `XXXX-XXXX` + mensagem pronta); a wallet real é identificada **somente na conexão**, com prova de posse por assinatura de challenge na Verum Wallet e **consumo atômico** do convite. Participantes veem a mesma mesa com **DTO recortado por papel no backend**; aprovação e assinaturas revalidam saldo/gás on-chain com motivos nominais; todos os timers usam o relógio do servidor.

## Arquivos

### Novos
- `src/domain/constants.ts` — parâmetros canônicos (TABLE_TTL_MINUTES=60, SIGN_WINDOW_MINUTES=5, INVITE_TTL_MINUTES=60, CHALLENGE_TTL_SECONDS=300, MIN_GAS_USD=5 + fallback 0,05 SOL, alfabeto do inviteCode sem 0/O/1/I/L, reexport de SIGNING_ORDER).
- `src/mesa/types.ts` — `MesaRecord`, `MesaChair`, `ChairAsset`, `MesaOperationConfig`, `MesaStatus`.
- `src/mesa/status.ts` — `deriveMesaStatus` (status derivado; sem máquina de estados paralela — a operação continua 100% no DealEngine).
- `src/mesa/mesaService.ts` — criação de mesa/cadeiras, convites por cadeira (código CSPRNG, hash + prefixo, mensagem pronta), resolve/challenge/join (prova de posse, nonce de uso único, consumo atômico, vínculo da cadeira, sessão de participante), DTO por papel, configuração (congelada na aprovação), cancelamento, auditoria nomeada.
- `src/mesa/balances.ts` — `validateChairBalances` (fonte única de validação de ativo + gás ≥ US$ 5 com leitores on-chain injetáveis; motivos nominais em PT-BR).
- `db/migrations/004_mesa.sql` — tabela `mesa_invites` (aditiva, idempotente; índice único parcial de 1 convite PENDING por cadeira; RLS sem policies).
- `test/mesa.store.test.ts` (8), `test/mesa.test.ts` (15), `test/mesa.api.test.ts` (3 cenários compostos) — 26 testes novos.

### Alterados
- `src/db/repository.ts` / `sqlStore.ts` / `memoryStore.ts` — `MesaInviteRow` + `insertMesaInvite`, `getMesaInvite`, `listMesaInvites`, `consumeMesaInvite` (**`UPDATE … WHERE status='PENDING' AND expires_at>$now RETURNING`**), `revokeMesaInvite`.
- `src/portal/portal.ts` — `PortalData.mesas`, `requirePayMaster`, `mesas()/persistMesas()`, `newMesaCode()` (gerador existente fatorado — formato não mudou), `walletLink` público; TTLs passam a vir das constantes canônicas (valores idênticos).
- `src/wallet/auth.ts` — claim opcional `mesa { mesaId, chairId, role, firstName }` no `Session` (sessão do participante, mesmo HMAC).
- `src/engines/deal.ts` — `SIGNER_WINDOW_MS` importado das constantes (mesmo valor, 5 min).
- `src/config.ts` / `src/app.ts` — challengeTtl via `CHALLENGE_TTL_MS`; `MesaService` no composition root; override `balanceReaders` para testes.
- `src/api/server.ts` — bloco de rotas v3:
  - Admin: `POST/GET /v1/portal/mesas`, `GET /v1/portal/mesas/:id`, `POST …/chairs/:chairId/invite`, `POST …/invites/:inviteId/revoke`, `POST …/chairs/:chairId/revoke`, `PATCH …/config` (409 após aprovação), `GET …/balances`, `POST …/approve` (validação completa + motivos nominais + criação da Deal pelo serviço existente), `POST …/deal/sign` (revalida saldos antes de assinar), `POST …/cancel`.
  - Público: `GET /v1/mesa-invites/:id` (`?c=`), `POST …/challenge`, `POST …/join`, `GET /v1/time`.
  - Participante: `GET /v1/mesas/:id` e `GET /v1/mesas/:id/balances` (DTO recortado); `PATCH /v1/mesas/:id/config` → 403 para participante.
  - Handlers legados de deal/sign da mesa fatorados (`createMesaDealForParts`, `signTurnOfDeal`) e reutilizados — sem lógica paralela.
  - Aliases de página: `/otc/convite/:token`, `/operacoes`, `/abrir-mesa`. `isPortalPath` estendido (hidratação JSONB nas rotas novas).
- `web/verum-dashboard.html` — menu "Carteiras" → **"ABRIR MESA"** (rota/data-view preservados); UI de criação de mesa/cadeiras; lista "Minhas mesas"; detalhe com convites (modal com código grande, link, mensagem pronta, Copiar/Compartilhar via Web Share), configuração, saldos ✓/✗, **Aprovar operação** com motivos nominais, assinatura da vez e cancelamento; card "Mesas" em Operações com badges (● ✓ ⚠ ✕), filtro por status e busca por código; **modo participante** (`/mesa?mesa=<id>#pt=<token>`) somente leitura com cards, resumo, bloco de assinaturas k/N, "Revisar e assinar" apenas na vez (tela de revisão + assinatura real via approval-envelope/approvals na Verum Wallet); **offset de relógio do servidor** (`/v1/time`) em todos os countdowns.
- `web/verum-convite.html` — fluxo v3 em `/otc/convite/<inviteId>?c=<código>`: campo primeiro nome (2–30), fallback de digitação do código, **gate Verum-only** pelo provider oficial (`window.verum`; nunca user-agent), bloqueio com "Abrir na Verum Wallet"/"Baixar Verum Wallet", challenge "Autorizar entrada na Mesa OTC" assinado integralmente, redirecionamento automático à mesa. Fluxo legado preservado.
- `PLANO.md` — plano de implementação (novo).

## Decisões

1. **Convites em tabela SQL própria** (`mesa_invites`), não no documento JSONB do portal: o consumo precisa ser atômico entre instâncias serverless; o JSONB singleton sofre race de sobrescrita. Challenges reutilizam a tabela `nonces` existente.
2. **Status da mesa derivado** (função pura) sobre cadeiras/convites/deal — nenhuma máquina de estados paralela; ordem/turnos/expiração continuam no DealEngine.
3. **Sessão do participante** = mesmo `Session` HMAC do WalletAuth com claim `mesa` — zero infraestrutura nova de sessão.
4. **Leitores de saldo injetáveis** (`BalanceReaders`): produção usa leitura on-chain real; testes usam mocks; mesas 100% demo usam saldos canned (sem RPC).
5. **Compatibilidade total**: endpoints e páginas legados (`/v1/portal/mesa/*`, `/convite/:token`) intactos; handlers fatorados e reutilizados.

## Conflitos prompt × código existente (implementado o prompt; registro)

- **Timer de 5 min**: o prompt diz "inicia na primeira assinatura"; o DealEngine existente inicia a janela rolante na **abertura do turno** (cada assinante tem 5 min na sua vez) — semântica mais estrita e já testada; mantida (a UI exibe o countdown do turno vigente).
- **Deep link `verumwallet://`**: o mecanismo oficial do projeto é o dapp-browser (`https://www.verumcrypto.com/dapp-browser?url=…`); usado no lugar do esquema custom (que a wallet não registra).
- **Código `OP-XXXXXXXX`**: inexistente no código (os geradores reais são `OTC-…` e `MESA-XXXX-XXXX-XXXX`); conforme a ordem "geradores existentes não são alterados", nada foi criado além do `inviteCode`.
- **Quantidade exigida do Comprador** na validação de saldo: o valor de contrapartida depende do cálculo econômico da Deal (congelado na aprovação); a pré-validação nominal cobre o volume do Vendedor + gás de todos; o saldo do Comprador é validado pelo DealEngine/escrow no funding.
- **Criação on-chain da Deal pela mesa** permanece nos modos dev/EVM/demo do serviço existente (como antes desta versão); em produção, a assinatura real passa pelo caminho `onchain-tx`/`approval-envelope`/`approvals` com a Verum Wallet (usado pelo modo participante).

## Verificação (saída real)

- `npm run lint` — 0 erros, 0 avisos (`--max-warnings=0`).
- `npm run typecheck` — limpo.
- `npm run build` — limpo.
- `npm test` — **Test Files 17 passed | 3 skipped (20) · Tests 168 passed | 4 skipped (172)** (142 pré-existentes + 26 novos; nenhum teste anterior quebrado).
- Fumaça e2e contra o dev server real (porta 8081): páginas (`/otc/convite/*`, `/mesa`, `/operacoes`), `/v1/time`, cadastro do PM, criação de 2 mesas com códigos distintos, convite com código e mensagem pronta, resolve, código errado bloqueado, challenge + join com assinatura ed25519 real, replay bloqueado, DTO do participante sem campos administrativos, 403 na edição por participante, aprovação bloqueada com motivo nominal, isolamento entre mesas — **21/21 verificações ok**.

> Operacional: `web/*.html` é lido no boot — reinicie o dev server após editar páginas. A migração `004_mesa.sql` é aplicada automaticamente por `SqlStore.init()` (pglite/postgres); no Supabase pode ser executada no SQL editor (idempotente).
