/**
 * Contrato OpenAPI 3.1 das rotas de Identidade Mínima (§2). Servido em GET /v1/identity/openapi.json.
 * Mantido à mão (e coberto por teste de consistência) para casar com os schemas zod das rotas.
 */
export function identityOpenApi(env: string): Record<string, unknown> {
  const bearer = [{ walletSession: [] }];
  const err = (desc: string) => ({ description: desc, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'VERUM OTC — Identidade Mínima',
      version: '1.0.0',
      description: 'Onboarding KYC-lite ancorado na carteira (§2). Apenas quatro elementos: carteira (pública), nome, e-mail e telefone (cifrados). OTP não é fator de login.',
    },
    servers: [{ url: '/', description: env }],
    components: {
      securitySchemes: {
        walletSession: { type: 'http', scheme: 'bearer', description: 'Token de sessão emitido por POST /v1/auth/verify (prova de posse da carteira).' },
      },
      schemas: {
        Error: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string', examples: ['NOT_ELIGIBLE'] }, message: { type: 'string' }, details: { type: ['object', 'null'] } } },
        Eligibility: { type: 'object', required: ['eligible', 'reasons'], properties: { eligible: { type: 'boolean' }, reasons: { type: 'array', items: { type: 'string' } } } },
        SettlementAddress: { type: 'object', required: ['caip10', 'verifiedAt'], properties: { caip10: { type: 'string' }, verifiedAt: { type: 'integer' } } },
        Identity: {
          type: 'object',
          required: ['userId', 'verificationLevel', 'walletCaip10', 'fullName', 'hasName', 'email', 'phone', 'settlementAddresses', 'eligibility'],
          properties: {
            userId: { type: 'string', examples: ['usr_9b1e…'] },
            verificationLevel: { type: 'string', enum: ['BASIC'] },
            walletCaip10: { type: 'string', examples: ['solana:localnet:So1…'] },
            fullName: { type: 'string', description: 'Visível ao próprio dono e aos co-participantes da operação.' },
            hasName: { type: 'boolean' },
            email: { type: 'object', required: ['verified', 'verifiedAt', 'masked'], properties: { verified: { type: 'boolean' }, verifiedAt: { type: ['integer', 'null'] }, masked: { type: 'string', examples: ['j***@g***.com'] } } },
            phone: { type: 'object', required: ['verified', 'verifiedAt', 'masked'], properties: { verified: { type: 'boolean' }, verifiedAt: { type: ['integer', 'null'] }, masked: { type: 'string', examples: ['+55 •• •••••-1234'] } } },
            settlementAddresses: { type: 'array', items: { $ref: '#/components/schemas/SettlementAddress' } },
            eligibility: { $ref: '#/components/schemas/Eligibility' },
          },
        },
        StartResult: { type: 'object', required: ['challengeId', 'expiresAt', 'masked'], properties: { challengeId: { type: 'string' }, expiresAt: { type: 'integer' }, masked: { type: 'string' }, devHint: { type: 'string', description: 'Somente em OTC_ENV=dev: o código OTP, para teste manual.' } } },
        RoomView: {
          type: 'object',
          required: ['id', 'status', 'members', 'invitations', 'confusableAlerts'],
          properties: {
            id: { type: 'string' }, status: { type: 'string', enum: ['OPEN', 'FILLED', 'CLOSED'] }, closedReason: { type: ['string', 'null'] },
            terms: { type: ['object', 'null'], properties: { version: { type: 'integer' }, termsHash: { type: 'string' }, fingerprint: { type: 'array', items: { type: 'string' }, description: '6 palavras (impressão digital para conferência verbal)' } } },
            members: { type: 'array', items: { allOf: [{ $ref: '#/components/schemas/Identity' }, { type: 'object', properties: { role: { type: 'string', enum: ['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2'] } } }] } },
            invitations: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, status: { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] }, expiresAt: { type: 'integer' } } } },
            confusableAlerts: { type: 'array', items: { type: 'object' } },
          },
        },
        InviteResult: { type: 'object', required: ['token', 'expiresAt', 'role'], properties: { token: { type: 'string', description: 'Token opaco de 256 bits; entregue no fragmento do link (#t=), nunca ao servidor por GET.' }, expiresAt: { type: 'integer' }, role: { type: 'string' } } },
        JoinChallenge: { type: 'object', required: ['roomId', 'role', 'termsVersion', 'joinMessage', 'nonce', 'expiresAt'], properties: { roomId: { type: 'string' }, role: { type: 'string' }, termsVersion: { type: 'integer' }, joinMessage: { type: 'string', description: 'Mensagem legível a assinar pela carteira (o cliente não escolhe o conteúdo).' }, nonce: { type: 'string' }, expiresAt: { type: 'integer' } } },
        WsTicket: { type: 'object', required: ['ticket', 'expiresAt'], properties: { ticket: { type: 'string', description: 'Uso único, TTL 30s. Enviar via Sec-WebSocket-Protocol; nunca token de sessão em query.' }, expiresAt: { type: 'integer' } } },
        ProposalChange: { oneOf: [
          { type: 'object', required: ['type', 'discountBps'], properties: { type: { const: 'discount' }, discountBps: { type: 'integer', minimum: 0, maximum: 2000 } } },
          { type: 'object', required: ['type', 'commissionBps'], properties: { type: { const: 'commission' }, commissionBps: { type: 'integer', minimum: 0, maximum: 5000 }, commissionSplitBps: { type: 'array', items: { type: 'integer' } } } },
          { type: 'object', required: ['type', 'amountInBase'], properties: { type: { const: 'amount' }, amountInBase: { type: 'string', pattern: '^[1-9][0-9]*$' } } },
          { type: 'object', required: ['type', 'expiresInSec'], properties: { type: { const: 'expiry' }, expiresInSec: { type: 'integer', minimum: 900 } } },
        ], description: 'Mudança tipada (nunca texto livre). Aplicar invalida assinaturas e retorna a AWAITING_SIGNATURES.' },
        Proposal: { type: 'object', required: ['id', 'dealId', 'revision', 'proposer', 'change', 'status'], properties: { id: { type: 'string' }, dealId: { type: 'string' }, revision: { type: 'integer' }, proposer: { type: 'string' }, change: { $ref: '#/components/schemas/ProposalChange' }, status: { type: 'string', enum: ['open', 'applied', 'withdrawn', 'rejected', 'stale'] } } },
      },
    },
    security: bearer,
    paths: {
      '/v1/identity/account': { post: { summary: 'Cria/garante a conta da carteira da sessão', security: bearer, responses: { '201': { description: 'Conta', content: { 'application/json': { schema: { $ref: '#/components/schemas/Identity' } } } }, '403': err('Sessão necessária') } } },
      '/v1/identity/me': { get: { summary: 'Visão própria da identidade', security: bearer, responses: { '200': { description: 'Identidade', content: { 'application/json': { schema: { $ref: '#/components/schemas/Identity' } } } }, '403': err('Sessão necessária') } } },
      '/v1/identity/eligibility': { get: { summary: 'Elegibilidade para operar', security: bearer, responses: { '200': { description: 'Elegibilidade', content: { 'application/json': { schema: { $ref: '#/components/schemas/Eligibility' } } } } } } },
      '/v1/identity/name': {
        put: {
          summary: 'Define o nome completo (autodeclarado, normalizado NFC, 2+ palavras)', security: bearer,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fullName'], properties: { fullName: { type: 'string', minLength: 3, maxLength: 120 } } }, examples: { ok: { value: { fullName: 'João da Silva' } } } } } },
          responses: { '200': { description: 'Identidade atualizada', content: { 'application/json': { schema: { $ref: '#/components/schemas/Identity' } } } }, '400': err('Nome inválido') },
        },
      },
      '/v1/identity/email/start': {
        post: {
          summary: 'Envia OTP de verificação de e-mail', security: bearer,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }, examples: { ok: { value: { email: 'joao@empresa.com' } } } } } },
          responses: { '201': { description: 'Desafio criado', content: { 'application/json': { schema: { $ref: '#/components/schemas/StartResult' }, examples: { ok: { value: { challengeId: 'k4c…', expiresAt: 1790000000000, masked: 'j***@e***.com' } } } } } }, '409': err('E-mail já em uso'), '429': err('Muitos códigos solicitados') },
        },
      },
      '/v1/identity/email/confirm': {
        post: {
          summary: 'Confirma o OTP de e-mail', security: bearer,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['challengeId', 'code'], properties: { challengeId: { type: 'string' }, code: { type: 'string', pattern: '^[0-9]{6}$' } } }, examples: { ok: { value: { challengeId: 'k4c…', code: '123456' } } } } } },
          responses: { '200': { description: 'Identidade atualizada', content: { 'application/json': { schema: { $ref: '#/components/schemas/Identity' } } } }, '400': err('Código inválido/expirado'), '429': err('Código bloqueado após muitas tentativas') },
        },
      },
      '/v1/identity/phone/start': {
        post: {
          summary: 'Envia OTP de verificação de telefone (E.164; allowlist de país)', security: bearer,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['phone'], properties: { phone: { type: 'string', examples: ['+5511999998888'] } } } } } },
          responses: { '201': { description: 'Desafio criado', content: { 'application/json': { schema: { $ref: '#/components/schemas/StartResult' } } } }, '403': err('País não habilitado'), '409': err('Telefone já em uso'), '429': err('Limite de SMS') },
        },
      },
      '/v1/identity/phone/confirm': {
        post: {
          summary: 'Confirma o OTP de telefone', security: bearer,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['challengeId', 'code'], properties: { challengeId: { type: 'string' }, code: { type: 'string', pattern: '^[0-9]{6}$' } } } } } },
          responses: { '200': { description: 'Identidade atualizada', content: { 'application/json': { schema: { $ref: '#/components/schemas/Identity' } } } }, '400': err('Código inválido/expirado') },
        },
      },
      '/v1/identity/settlement-address': {
        post: {
          summary: 'Adiciona endereço de liquidação após prova de posse (assinatura de desafio na rede do endereço)', security: bearer,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['network', 'address', 'nonce', 'signature', 'issuedAt', 'expiresAt'], properties: { network: { type: 'string', enum: ['bitcoin', 'ethereum', 'solana', 'zcash'] }, address: { type: 'string' }, nonce: { type: 'string' }, signature: { type: 'string' }, issuedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' } } } } } },
          responses: { '201': { description: 'Endereço vinculado', content: { 'application/json': { schema: { $ref: '#/components/schemas/Identity' } } } }, '400': err('Assinatura inválida'), '409': err('Endereço já vinculado a outra conta') },
        },
      },
      '/v1/rooms': { post: { summary: 'Cria uma sala (somente PM01, elegível)', security: bearer, responses: { '201': { description: 'Sala', content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomView' } } } }, '403': err('Inelegível/sessão') } } },
      '/v1/rooms/{id}': { get: { summary: 'Estado da sala (só participantes)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Sala', content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomView' } } } }, '403': err('Não participante') } } },
      '/v1/rooms/{id}/terms': { post: { summary: 'Define termos (impressão digital)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version', 'termsHash'], properties: { version: { type: 'integer', minimum: 1 }, termsHash: { type: 'string', minLength: 64, maxLength: 64 } } } } } }, responses: { '200': { description: 'Sala', content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomView' } } } } } } },
      '/v1/rooms/{id}/invites': {
        post: {
          summary: 'Convida por e-mail OU telefone EXATO (anti-enumeração: resposta idêntica exista ou não a conta)', security: bearer,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['SELLER', 'BUYER', 'PAYMASTER_2'] }, email: { type: 'string' }, phone: { type: 'string' } } }, examples: { email: { value: { role: 'SELLER', email: 'vendedor@x.com' } } } } } },
          responses: { '201': { description: 'Convite', content: { 'application/json': { schema: { $ref: '#/components/schemas/InviteResult' } } } }, '403': err('Apenas PM01'), '409': err('Papel já preenchido') },
        },
      },
      '/v1/rooms/{id}/invites/revoke': { post: { summary: 'Revoga convite pendente por papel', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['role'], properties: { role: { type: 'string' } } } } } }, responses: { '200': { description: 'Sala', content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomView' } } } } } } },
      '/v1/rooms/invite/resolve': { post: { summary: 'Resolve o token (no corpo) → mensagem de ingresso a assinar', security: bearer, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } }, responses: { '200': { description: 'Desafio de ingresso', content: { 'application/json': { schema: { $ref: '#/components/schemas/JoinChallenge' } } } }, '400': err('Convite inválido/expirado') } } },
      '/v1/rooms/accept': { post: { summary: 'Aceita o convite (consumo atômico do token + assinatura de ingresso)', security: bearer, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token', 'nonce', 'signature'], properties: { token: { type: 'string' }, nonce: { type: 'string' }, signature: { type: 'string' } } } } } }, responses: { '201': { description: 'Sala', content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomView' } } } }, '400': err('Assinatura/convite inválido') } } },
      '/v1/rooms/{id}/ws-ticket': { post: { summary: 'Ticket de WebSocket de uso único (TTL 30s)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Ticket', content: { 'application/json': { schema: { $ref: '#/components/schemas/WsTicket' } } } } } } },
      '/v1/rooms/{id}/close': { post: { summary: 'Encerra a sala (irreversível)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } } }, responses: { '200': { description: 'Sala encerrada', content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomView' } } } } } } },
      '/v1/rooms/{id}/stream': { get: { summary: 'WebSocket da sala (ticket via Sec-WebSocket-Protocol; valida Origin; autorização por sala)', description: 'Upgrade WebSocket. O ticket de uso único vai no subprotocolo "verum-ticket,<ticket>", nunca em query. Estado autoritativo no servidor; o cliente só recebe eventos.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '101': { description: 'Switching Protocols' }, '401': err('Ticket inválido'), '403': err('Origin inválida') } } },
      '/v1/deals/{id}/proposals': {
        post: { summary: 'Propõe alteração estruturada de termos (participante)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProposalChange' } } } }, responses: { '201': { description: 'Proposta criada + preview do impacto' }, '403': err('Não participante'), '409': err('Estado não permite alteração') } },
        get: { summary: 'Lista propostas da operação (participantes)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Lista de propostas' } } },
      },
      '/v1/deals/{id}/proposals/{pid}/apply': { post: { summary: 'Aplica a proposta (somente o criador): version++ invalida assinaturas e volta a AWAITING_SIGNATURES', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'pid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deal na nova revisão' }, '403': err('Apenas o criador'), '409': err('Proposta obsoleta') } } },
      '/v1/deals/{id}/proposals/{pid}/withdraw': { post: { summary: 'Proponente retira a proposta', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'pid', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Proposta atualizada' } } } },
      '/v1/deals/{id}/proposals/{pid}/reject': { post: { summary: 'Participante rejeita a proposta', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'pid', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Proposta atualizada' } } } },
    },
  };
}
