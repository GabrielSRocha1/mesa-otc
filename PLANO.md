# PLANO — VERUM OTC v3: mesas multi-instância, cadeiras + convites, conexão Verum Wallet

## O que existe (auditoria)

- **DealEngine** (`src/engines/deal.ts`): ordem obrigatória Vendedor→PM1→PM2→Comprador, janela rolante de 5 min por assinante, expiração, nonces de uso único, idempotência, rejeição de assinatura fora de ordem no backend, estados DRAFT→…→SETTLED.
- **WalletAuth** (`src/wallet/auth.ts`): challenge com nonce CSPRNG (TTL 5 min), mensagem reconstruída server-side, verify EVM/Solana/Tron/Bitcoin, consumo atômico do nonce, sessão HMAC.
- **PortalService** (`src/portal/portal.ts`): cadastro/login scrypt, 2FA TOTP, bloqueio por inatividade, alertas, código de mesa `MESA-XXXX-XXXX-XXXX` (TTL 1 h), convites por papel (singleton por Pay Master), persistência serverless em documento JSONB (`portal_state`).
- **API** (`src/api/server.ts`): `/v1/auth/*`, `/v1/portal/*`, `/v1/deals/*` (envelope, approvals, onchain-tx para carteira real), `/v1/chains/balances` (saldo nativo + tokens + preço USD das 18 redes), rate limit, Idempotency-Key.
- **Cálculo único** `computeEconomics` (`src/engines/price.ts`); **auditoria** append-only encadeada (`src/audit/audit.ts`); **frontend** autocontido em `web/` (dashboard SPA por abas, portal, convite, `verum-provider.js` = ponte oficial window.verum da Verum Wallet).

## O que será reutilizado

DealEngine (motor único — intocado na lógica), WalletAuth (primitivas da prova de posse + sessão do participante), PortalService + persistência JSONB (casa do modelo Mesa/Chair), padrão `consumeNonce` atômico do Store, `computeEconomics`, leitores de saldo/preço (`src/chains/*`), fluxo on-chain real (`onchain-tx`/`approval-envelope`/`approvals`), AuditLog, páginas HTML existentes, alfabeto sem caracteres ambíguos de `humanTradeCode`.

## O que muda

1. **Constantes canônicas** em `src/domain/constants.ts` (TABLE_TTL_MINUTES=60, SIGN_WINDOW_MINUTES=5, INVITE_TTL_MINUTES=60, CHALLENGE_TTL_SECONDS=300, MIN_GAS_USD=5 c/ fallback 0,05 SOL, PLATFORM_FEE_BPS=3, SIGNING_ORDER, alfabeto do inviteCode) — fim dos números mágicos.
2. **Multi-mesa**: `PortalData.mesas` (mesaId, código, rede única, 3–4 cadeiras sem wallet na criação). O Pay Master nunca cadastra endereço de wallet.
3. **Convite por cadeira**: tabela SQL `mesa_invites` (inviteId + inviteCode `XXXX-XXXX` com hash + prefixo, status PENDING|USED|REVOKED, usedBy/usedAt) com **consumo atômico** `UPDATE … WHERE status='PENDING' RETURNING`; link `/otc/convite/<inviteId>?c=<code>`, mensagem pronta com aviso Verum Wallet + volume do ativo + US$ 5 de gás.
4. **Conexão do participante**: primeiro nome (2–30) + challenge "Autorizar entrada na Mesa OTC" exibido integralmente, assinado na Verum Wallet (EIP-191 / ed25519); mesma wallet não ocupa duas cadeiras; sessão de participante (claim `mesa` no Session HMAC).
5. **DTO recortado por papel no backend**: admin vê tudo; Vendedor/Comprador/PM2 veem somente o pertinente (sem links/códigos/admin), com saldos de todos.
6. **Aprovação admin-only** com validação completa (conexões, posse, ativos, saldos + gás ≥ US$ 5 revalidados on-chain, prazos) e motivos nominais; revalidação antes de cada assinatura.
7. **Estados da mesa derivados** (sem máquina paralela) sobre cadeiras/convites/deal: DRAFT→WAITING_INVITES→WAITING_CONNECTIONS→ACTIVE→READY_FOR_APPROVAL→APPROVED→WAITING_SIGNATURES→SIGNING→COMPLETED (+SIGNATURE_TIMEOUT, EXPIRED, CANCELLED, FAILED).
8. **Frontend**: menu "ABRIR MESA" e "Operações" (lista com badges), modo participante na mesma dashboard, página de convite Verum-only com fallback de código, timers pelo relógio do servidor (offset), "Revisar e assinar"/"Cancelar" ligados ao fluxo real.

## Migrações

- `db/migrations/004_mesa.sql` (aditiva, idempotente): tabela `mesa_invites` + índices (`mesa_id`; único parcial `(mesa_id, chair_id) WHERE status='PENDING'`). Challenges reutilizam a tabela `nonces`.

## Endpoints novos

Portal (admin): `POST/GET /v1/portal/mesas`, `GET /v1/portal/mesas/:id`, `POST /v1/portal/mesas/:id/chairs/:chairId/invite`, `POST /v1/portal/mesas/:id/invites/:inviteId/revoke`, `PATCH /v1/portal/mesas/:id/config` (403/409), `POST /v1/portal/mesas/:id/approve` (+2FA), `POST /v1/portal/mesas/:id/cancel`.
Público: `GET /v1/mesa-invites/:inviteId` (`?c=`), `POST /v1/mesa-invites/:inviteId/challenge`, `POST /v1/mesa-invites/:inviteId/join`, `GET /v1/time`.
Participante: `GET /v1/mesas/:id` (DTO por papel). Rotas antigas preservadas; aliases `GET /otc/convite/:inviteId` e `/operacoes`.

## Componentes

Novos módulos: `src/domain/constants.ts`, `src/mesa/{types,mesaService,joinAuth,balances,status}.ts`. Frontend: evolução de `web/verum-dashboard.html` (ABRIR MESA, Operações, modo participante) e `web/verum-convite.html` (nome, código, gate Verum-only). Testes novos: `test/mesa.store.test.ts`, `test/mesa.test.ts`, `test/mesa.api.test.ts` (20 cenários do prompt) + suíte existente verde.
