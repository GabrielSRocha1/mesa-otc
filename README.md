# VERUM OTC

Plataforma institucional OTC/P2P multichain com liquidação N-de-N (Vendedor, Comprador, 1–2 Pay Masters).

## Estrutura
- `src/` — backend TypeScript (Fastify 5): engines (deal, preço, liquidez, rota, assinatura, risco, liquidação), API, WebSocket/SSE, auth por carteira, auditoria, métricas
- `web/verum-dashboard.html` — mesa de operação (dashboard + abas, em `/mesa`); `web/verum-saas.html` — portal Pay Master (`/portal`); `web/verum-convite.html` — confirmação de convite (`/convite/:token`)
- `contracts/VerumOtcEscrow.sol` — smart contract core (EVM); `contracts/mocks/` — mocks de teste
- `test/` — vitest (backend, API, SQL/PGlite, contrato em EVM real); `test/foundry/` — unitários, fuzz e invariantes (Foundry)
- `db/migrations/` — schema PostgreSQL; `ops/alerts.yml` — regras Prometheus; `script/` — deploy (forge script)
- `docs/` — PRD, Arquitetura, Hardening Report, Smart Contract Report

## Setup
```bash
npm ci                      # Node >= 22
npm run verify              # lint + typecheck + build + vitest + solc
npm run dev                 # API em http://127.0.0.1:8080 (OTC_ENV=dev, simuladores locais)
```
Mesa de operação: abrir http://127.0.0.1:8080/mesa (portal em `/portal`)

Foundry (contratos): instale o Foundry (https://book.getfoundry.sh) e um solc 0.8.30 nativo, ajuste `solc` em `foundry.toml` (ou remova a linha para o forge baixar), então:
```bash
forge test                  # 23 unitários + 3 fuzz + 4 invariantes
npm run contracts:compile   # ABI/bytecode para o backend em contracts/out/
```
Variáveis de ambiente: ver `.env.example`. Nunca commitar segredos. Nenhum deploy em mainnet sem auditoria independente.
