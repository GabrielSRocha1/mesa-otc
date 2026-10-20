# Rota LIGHTNING_SWAP — setup do nó LND

A perna BTC do swap pode ser entregue via **Lightning Network** (1–2 s), acoplada atomicamente à
perna USDT do escrow V2 pelo **preimage compartilhado**: a invoice do Comprador tem
`payment_hash = htlcHash` do deal; ao pagar a invoice, o nó obtém a `r_preimage = preimage`, que
destrava o `settleV2` on-chain (o contrato valida `sha256(preimage) == htlcHash`). A rota HTLC P2WSH
on-chain permanece **intacta** como fallback (valores grandes / canais indisponíveis).

**Modelo:** a mesa é a **market-maker de BTC** — o nó paga a invoice com a **própria liquidez
outbound** e recebe o USDT no settle. Nunca custodia BTC do cliente; os fundos do nó ficam limitados
ao HTLC em trânsito. O nó **só paga** depois que o USDT está travado on-chain (`getDealState → FUNDED`).

## Variáveis de ambiente (grupo all-or-nothing)

| Variável | Finalidade | Produção | Teste/preview |
|---|---|---|---|
| `LND_REST_URL` | endpoint REST do LND (ex.: `https://nó:8080`) | nó próprio | — |
| `LND_MACAROON` | macaroon em **hex**, escopo mínimo (invoice + offchain + readonly) | obrigatório | — |
| `LND_TLS_CERT` | `tls.cert` do nó (PEM ou base64 do PEM) | obrigatório | — |
| `LND_INVOICE_EXPIRY_SEC` | expiry curto da invoice (default 600 = 10 min) | opcional | opcional |
| `LND_PAYMENT_TIMEOUT_SEC` | teto do pagamento LN (default 60) | opcional | opcional |
| `LND_SIMULATE` | `1` força o simulador in-process mesmo com o grupo real presente | `0` | `1` |

**Regras:** o grupo é **all-or-nothing** (como `BITCOIN_*`/`VERUM_EVM_*`): ou os três
(`LND_REST_URL`+`LND_MACAROON`+`LND_TLS_CERT`) presentes, ou nenhum. Ausente ou `LND_SIMULATE=1` →
simulador. **Nunca** logar o macaroon nem o cert. O macaroon deve ter **escopo mínimo** — gerar com
`lncli bakemacaroon invoices:write invoices:read offchain:write offchain:read info:read` e converter:
`xxd -p -c 9999 mínimo.macaroon` (hex).

## Teste local — Polar (regtest)

1. Instale o [Polar](https://lightningpolar.com/). Crie uma rede regtest com ≥2 nós LND com um canal
   aberto entre eles (um é a mesa, o outro simula o Comprador recebendo).
2. No nó da mesa, pegue: REST URL (ex.: `https://127.0.0.1:8081`), `admin.macaroon` (hex) e `tls.cert`.
3. `.env`:
   ```
   LND_SIMULATE=0
   LND_REST_URL=https://127.0.0.1:8081
   LND_MACAROON=<hex do macaroon>
   LND_TLS_CERT=<conteúdo do tls.cert (PEM)>
   ```
4. Abra canais com liquidez **outbound** suficiente na mesa (ela paga o BTC). O precheck da aprovação
   bloqueia se `channelBalance.local < amount`.

## Teste automático — sem nó (CI)

A suíte usa um **LND fake in-process** (`test/lndFake.ts`, modelo do `esploraRegtest`) que fala o
subconjunto REST consumido pelo `LndRestService` e casa `sha256(preimage) == payment_hash`. Roda no
`npm run verify` sem infraestrutura externa:
- `test/lightning.service.test.ts` — cliente REST real × fake + simulador.
- `test/lightning.swap.test.ts` — a mecânica atômica do coordinator (5 cenários).

## Ligar o nó em produção (deploy Vercel)

O deploy chama o REST do LND **de fora** (funções serverless) — o nó precisa estar **acessível pela
internet** (REST público com TLS). Um nó local/Polar **não** serve para o deploy (só para dev local).

**Par correto hoje:** a perna USDT roda na **Sepolia (testnet)**. O nó LND deve ser **testnet/signet**
— nunca mainnet, senão a mesa entrega **BTC real** contra tUSDT sem valor. Signet (Mutinynet) é a rede
Lightning de teste mais saudável hoje (blocos regulares, faucet).

Passos:
1. **Suba um nó testnet/signet acessível pela internet.** Opções:
   - *Gerenciado (mais rápido):* um provedor de nó LND gerenciado (ex.: Voltage) numa rede de teste —
     já entrega REST público + `admin.macaroon` + `tls.cert`, sem VPS para administrar.
   - *Autocustodiado:* LND em signet num VPS, com a porta REST (8080) exposta por HTTPS.
2. **Abra ≥1 canal com liquidez OUTBOUND** (é o BTC que a mesa entrega). Em signet/Mutinynet use o
   faucet + um par de canal. O precheck da aprovação barra se `outbound < amount` do swap.
3. **Gere o macaroon de escopo mínimo** e converta para hex (ver abaixo); pegue o `tls.cert`.
4. **Grave as envs no deploy** (Production na Vercel) — `LND_SIMULATE=0`, `LND_REST_URL`,
   `LND_MACAROON` (hex), `LND_TLS_CERT` (PEM ou base64). Grupo all-or-nothing: os três juntos.
5. **Valide a conexão** antes de confiar: `npx tsx --env-file=.env scripts/lnd-check.mts` (com as
   envs do nó no `.env` local, apontando para o nó de produção). Confirma `getinfo`, a **rede** do nó
   e a liquidez OUTBOUND — e avisa se parecer mainnet ou se o outbound for zero. Nunca imprime segredos.
6. **Redeploy** e teste um swap Lightning ponta a ponta no deploy.

## Produção

- Nó LND **dedicado e autocustodiado** (não compartilhar com outros serviços). Macaroon de escopo
  mínimo; TLS com o cert do nó. Monitorar **force-close** de canais durante um swap ativo.
- Dimensionar a liquidez **outbound** ao volume esperado de swaps (é o BTC que a mesa entrega).
- A invoice tem expiry curto (~10 min): se nunca paga, o BTC **nunca sai** do nó (nada a reembolsar na
  perna BTC); o USDT do Comprador volta pelo `refundV2` após a janela do contrato.
- **Nunca** fazer deploy com `LND_SIMULATE=1` em produção (o simulador não move BTC real).

## Segurança (invariantes)

- Atomicidade **ambos-ou-nenhum** em todos os cenários: o nó paga a invoice **somente** após o USDT
  `FUNDED` on-chain; só então obtém R e chama `settleV2(R)`.
- A preimage R é do **Comprador** — a mesa não a conhece antes do pagamento, logo não pode liquidar
  sem pagar.
- Watcher/settle **idempotentes** (dupla liquidação é no-op).
