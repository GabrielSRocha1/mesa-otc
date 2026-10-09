/**
 * API boundaries (arquitetura §9). Fastify 5 + WebSocket. A API traduz HTTP em comandos do Deal Engine;
 * nunca escreve no store diretamente. Idempotency-Key obrigatória em POST/PATCH; rate limit por IP/sessão/endpoint.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { DomainError, HTTP_STATUS } from '../domain/errors.js';
import { sha256Hex, canonicalize, type Deal, type Network, type Role } from '../domain/types.js';
import type { DealEngine, DealEventMsg } from '../engines/deal.js';
import type { SettlementEngine } from '../engines/settlement.js';
import type { PriceEngine } from '../engines/price.js';
import type { LiquidityEngine } from '../engines/liquidity.js';
import type { RouterEngine } from '../engines/router.js';
import { NETWORK_KEY_SCHEME } from '../domain/types.js';
import type { AssetRegistry } from '../engines/assetRegistry.js';
import type { WalletAuth, Session } from '../wallet/auth.js';
import type { PortalService } from '../portal/portal.js';
import type { IdentityService } from '../identity/service.js';
import type { FakeEmailChannel, FakeSmsChannel } from '../identity/otp.js';
import type { RoomService, RoomActor } from '../rooms/service.js';
import { WsClientMessage, INVITABLE_ROLES } from '../rooms/types.js';
import { type ProposalService, ProposalChangeZ } from '../proposals/service.js';
import { identityOpenApi } from './identityOpenapi.js';
import { MANIFEST_JSON, SW_JS, ICON_SVG, ICON_MASKABLE_SVG, OFFLINE_HTML, injectPwa, injectPwaNoSW } from './pwa.js';
import type { Store } from '../db/repository.js';
import { AuditLog } from '../audit/audit.js';
import { hasParticipantSteps, type AdapterRegistry } from '../adapters/types.js';
import { registry as metricsRegistry, logger, metrics } from '../monitoring/metrics.js';
import { randomUUID } from 'node:crypto';
import { allChains, getChain, chainIconId } from '../chains/registry.js';
import { getPrices, getPricesById } from '../chains/prices.js';
import { readNativeBalance } from '../chains/balances.js';
import { readTokenBalances } from '../chains/tokenBalances.js';
import { stablecoinNetworks } from '../chains/tokens.js';
import { getIconMap } from '../chains/icons.js';
import type { MesaService, AuthNetwork } from '../mesa/mesaService.js';
import { validateChairBalances, defaultBalanceReaders, addressOn, type BalanceReaders } from '../mesa/balances.js';
import { deriveSettlementPlan } from '../mesa/settlementPlan.js';
import type { MesaChair, MesaRecord } from '../mesa/types.js';
import registryData from '../onchain/registry/registryData.js';
import { registryChecker, verumWalletChecker, composeCheckers, validateMesaTokens } from '../mesa/antiscam.js';

const MAX_STREAMS_PER_SESSION = 8; const streams = new Map<string, number>();

/** Simulador local usado só em dev para dar saldo ao Vendedor ao criar a Deal-demo da mesa. */
export interface DevMint { solanaChainId: string; mint: (address: string, contract: string | null, amount: bigint) => unknown; evm?: DevEvm; demo?: DevDemo; ensureOnChain?: (dealId: string) => Promise<void> }
/** Conta demo (apresentações): keyring das 4 carteiras falsas + set de todos os endereços fake. */
export interface DevDemo { keyring: import('../portal/demo.js').DemoMesaKeyring; addresses: Set<string> }
/** Modo EVM dev: contrato real (Sepolia/anvil), keyring de EOAs dev e mint dos tokens mock. */
export interface DevEvmKeyring { addressFor(owner: string): string; accountByAddress(address: string): import('viem/accounts').PrivateKeyAccount | null }
export interface DevEvm { chainId: string; escrow: string; tbtc: `0x${string}`; tusdt: `0x${string}`; explorerBase: string | null; keyring: DevEvmKeyring; mintToken: (token: `0x${string}`, to: string, amount: bigint) => Promise<void> }
export interface ApiDeps { deals: DealEngine; settlement: SettlementEngine; price: PriceEngine; liquidity: LiquidityEngine; router: RouterEngine; registry: AssetRegistry; adapters?: AdapterRegistry; platformFeeBps: number; networkCostUsd: (n: Network) => Promise<string>; auth: WalletAuth; portal: PortalService; identity: IdentityService; identityDev?: { email: FakeEmailChannel; sms: FakeSmsChannel }; rooms: RoomService; proposals: ProposalService; mesa: MesaService; balanceReaders?: BalanceReaders; store: Store; audit: AuditLog; mesaHtmlPath?: string; portalHtmlPath?: string; conviteHtmlPath?: string; env: string; rateLimit?: { windowMs: number; max: number }; dev?: DevMint }
declare module 'fastify' { interface FastifyRequest { session: Session | null } }

const NetworkZ = z.enum(['bitcoin', 'ethereum', 'solana', 'zcash', 'tron']); const RoleZ = z.enum(['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2']);
// Endereços multichain expostos pela carteira (opcional em connect/confirm/join). TOLERANTE:
// entradas malformadas vindas da wallet (endereço curto/vazio, rede estranha) são DESCARTADAS em
// vez de derrubar a requisição inteira com "Entrada inválida" — o dado é público/informativo;
// a prova de posse continua sendo o challenge assinado.
const WalletAddressesZ = z.array(z.unknown()).max(50).nullish().transform(list =>
  !list ? undefined : list.flatMap(a => {
    const o = a as { network?: unknown; address?: unknown } | null;
    const network = typeof o?.network === 'string' ? o.network.trim() : '';
    const address = typeof o?.address === 'string' ? o.address.trim() : '';
    return network.length >= 2 && network.length <= 40 && address.length >= 8 && address.length <= 120 ? [{ network, address }] : [];
  }).slice(0, 30)
);
const short = (d: Deal) => ({ id: d.id, state: d.state, revision: d.revision, requiredSignatures: d.requiredSignatures, validSignatures: d.validSignatures, expiresAt: d.expiresAt, turnRole: d.turnRole ?? null, turnExpiresAt: d.turnExpiresAt ?? null, updatedAt: d.updatedAt, assetIn: d.draft.assetIn.assetId, assetOut: d.draft.assetOut.assetId, amountInBase: d.draft.amountInBase });

/** Rate limiter token-bucket em memória (por chave). Em produção o edge (Cloudflare) e um bucket em Redis complementam. */
class Bucket { private hits = new Map<string, number[]>(); private lastPrune = 0; constructor(private readonly windowMs: number, private readonly max: number) {}
  take(key: string, now: number): boolean { if (now - this.lastPrune > this.windowMs) { this.lastPrune = now; for (const [k, v] of this.hits) if (v.every(t => t <= now - this.windowMs)) this.hits.delete(k); } const arr = (this.hits.get(key) ?? []).filter(t => t > now - this.windowMs); if (arr.length >= this.max) { this.hits.set(key, arr); return false; } arr.push(now); this.hits.set(key, arr); return true; } }

// Cache em memória dos bytes dos logos (proxy same-origin p/ satisfazer o CSP
// img-src 'self'). Logos quase nunca mudam → TTL longo.
const iconBufCache = new Map<string, { at: number; ct: string; buf: Buffer }>();
const ICON_BUF_TTL = 24 * 3600 * 1000;

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: true });
  await app.register(cors, { origin: false }); await app.register(websocket);
  const bucket = new Bucket(deps.rateLimit?.windowMs ?? 60_000, deps.rateLimit?.max ?? 120);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req, reply) => {
    const rid = typeof req.headers['x-request-id'] === 'string' && /^[\w.-]{8,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID(); void reply.header('x-request-id', rid);
    // O OTC precisa rodar DENTRO do navegador dApp da Verum (iframe) → permitimos enquadramento
    // apenas pelas origens da Verum. Não enviamos X-Frame-Options (não faz allowlist por origem e
    // sobreporia o CSP); o controle fica no `frame-ancestors` do CSP abaixo.
    void reply.header('x-content-type-options', 'nosniff'); void reply.header('referrer-policy', 'no-referrer'); void reply.header('cache-control', 'no-store'); void reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains'); void reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (!(req.routeOptions.url ?? req.url).startsWith('/v1/ws')) void reply.header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self' https://verumcrypto.com https://*.verumcrypto.com; base-uri 'none'; form-action 'none'");
    req.session = deps.auth.parse((req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined);
    const key = `${req.session?.sub ?? req.ip}:${req.routeOptions.url ?? req.url}`;
    if (!bucket.take(key, Date.now())) { await reply.code(429).send({ error: 'RATE_LIMITED', message: 'Muitas requisições. Tente novamente em instantes.' }); }
  });
  // Persistência do portal no serverless: hidrata o estado do backend (postgres) por request de
  // portal (vê escritas de outras instâncias) e, após mutações, persiste antes de responder.
  const isPortalPath = (u: string): boolean => u.startsWith('/v1/portal') || u.startsWith('/v1/mesas') || u.startsWith('/v1/mesa-invites');
  app.addHook('onRequest', async req => { if (isPortalPath(req.routeOptions.url ?? req.url)) await deps.portal.hydrate(); });
  app.addHook('onSend', async (req, _reply, payload) => { const m = req.method; if ((m === 'POST' || m === 'PUT' || m === 'PATCH') && isPortalPath(req.routeOptions.url ?? req.url)) await deps.portal.flush(); return payload; });
  app.addHook('onResponse', async (req, reply) => { const route = req.routeOptions.url ?? 'unmatched'; metrics.httpRequests.inc({ route, status: String(reply.statusCode) }); metrics.httpSeconds.observe({ route }, reply.elapsedTime / 1000); if (reply.statusCode >= 500) logger.error({ rid: reply.getHeader('x-request-id'), route, status: reply.statusCode }, 'http 5xx'); });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) { void reply.code(HTTP_STATUS[err.code]).send({ error: err.code, message: err.message, details: err.details ?? null }); return; }
    const e = err as Error & { statusCode?: number; validation?: unknown };
    if (e.statusCode && e.statusCode < 500) { void reply.code(e.statusCode).send({ error: 'BAD_REQUEST', message: e.message }); return; }
    logger.error({ err: e.message }, 'erro não tratado'); void reply.code(500).send({ error: 'INTERNAL', message: 'Erro interno' });
  });
  const requireSession = (req: FastifyRequest): Session => { if (!req.session) throw new DomainError('FORBIDDEN', 'Sessão necessária'); return req.session; };
  const requireOperator = (req: FastifyRequest): Session => { const s = requireSession(req); if (s.role !== 'operator') throw new DomainError('FORBIDDEN', 'Apenas operadores'); return s; };
  /** Idempotência: mesma chave + mesmo corpo ⇒ resposta original; corpo diferente ⇒ 409. */
  const idempotent = async <T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> => {
    const key = req.headers['idempotency-key']; const actor = req.session?.sub ?? req.ip;
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new DomainError('INVALID_INPUT', 'Cabeçalho Idempotency-Key obrigatório (8–128 caracteres)');
    const reqHash = sha256Hex(canonicalize({ url: req.url, body: req.body ?? null }));
    const prev = await deps.store.getIdempotent(key, actor);
    if (prev) { if (prev.requestHash !== reqHash) throw new DomainError('VERSION_CONFLICT', 'Idempotency-Key reutilizada com corpo diferente'); void reply.header('Idempotent-Replayed', 'true'); return prev.response as T; }
    const res = await fn(); await deps.store.putIdempotent(key, actor, reqHash, res, Date.now()); return res;
  };
  // Nomeia os campos reprovados na mensagem — "Entrada inválida" seco não é diagnosticável
  // pelo usuário (ex.: assinatura da wallet chegando vazia aparecia sem pista nenhuma).
  const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
    const r = schema.safeParse(v);
    if (!r.success) {
      const fields = r.error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'corpo'}: ${i.message}`).join(' · ');
      throw new DomainError('INVALID_INPUT', `Entrada inválida (${fields})`, { issues: r.error.issues });
    }
    return r.data;
  };

  /* ---------- saúde e métricas ---------- */
  app.get('/health', async () => ({ ok: true, env: deps.env, time: Date.now(), adapters: deps.adapters?.all().map(a => `${a.chain.network}:${a.chain.chainId}`) ?? [] }));
  // Diagnóstico da persistência do portal: roundtrip de escrita + resumo do singleton NO BANCO.
  // Não expõe dados sensíveis (só contagens e mensagens de erro de infraestrutura).
  app.get('/health/portal', async () => ({ persistence: (await deps.portal.persistenceHealth()) ?? 'memória/arquivo (sem backend async)' }));
  app.get('/metrics', async (_req, reply) => { void reply.header('content-type', metricsRegistry.contentType); return metricsRegistry.metrics(); });

  /* ---------- auth ---------- */
  app.get('/v1/auth/challenge', async req => { const q = parse(z.object({ network: NetworkZ, address: z.string().min(20).max(120) }), req.query); return deps.auth.challenge(q.network, q.address); });
  // issuedAt/expiresAt OPCIONAIS (compat): o verify reconstrói a mensagem do nonce persistido.
  app.post('/v1/auth/verify', async req => { const b = parse(z.object({ network: NetworkZ, address: z.string(), nonce: z.string(), signature: z.string().min(20), issuedAt: z.union([z.string(), z.number()]).optional(), expiresAt: z.union([z.string(), z.number()]).optional() }), req.body); const r = await deps.auth.verify(b.network, b.address, b.nonce, b.signature, b.issuedAt == null ? undefined : String(b.issuedAt), b.expiresAt == null ? undefined : String(b.expiresAt)); await deps.audit.append({ actorType: 'user', actorId: r.session.sub, category: 'auth.login', dealId: null, payload: { network: b.network } }); return r; });
  app.get('/v1/me', async req => requireSession(req));

  /* ---------- Identidade mínima (§2) — ancorada na carteira (sessão do WalletAuth) ---------- */
  const caip10Of = (s: Session): string => `${s.network}:${s.chainId}:${s.address}`;
  // Resolve (ou cria) a conta de identidade da carteira da sessão e devolve o userId.
  const identityUser = (req: FastifyRequest): { session: Session; userId: string } => { const s = requireSession(req); const { userId } = deps.identity.ensureAccount(caip10Of(s)); return { session: s, userId }; };
  // Em dev, devolve o último código enviado no canal (facilita o teste manual; nunca em prod).
  const devHint = (channel: 'email' | 'sms'): string | undefined => { if (deps.env !== 'dev' || !deps.identityDev) return undefined; return (channel === 'email' ? deps.identityDev.email : deps.identityDev.sms).sent.slice(-1)[0]?.code; };

  app.get('/v1/identity/openapi.json', async () => identityOpenApi(deps.env));
  app.post('/v1/identity/account', async (req, reply) => { const { userId } = identityUser(req); void reply.code(201); return deps.identity.describe(userId); });
  app.get('/v1/identity/me', async req => { const { userId } = identityUser(req); return deps.identity.describe(userId); });
  app.get('/v1/identity/eligibility', async req => { const { userId } = identityUser(req); return deps.identity.eligibility(userId); });
  app.put('/v1/identity/name', async req => { const { userId } = identityUser(req); const b = parse(z.object({ fullName: z.string().min(1).max(200) }), req.body); deps.identity.setFullName(userId, b.fullName); return deps.identity.describe(userId); });

  app.post('/v1/identity/email/start', async (req, reply) => { const { userId } = identityUser(req); const b = parse(z.object({ email: z.string().min(1).max(200) }), req.body); const r = await deps.identity.startEmailVerification(userId, b.email); void reply.code(201); return { ...r, devHint: devHint('email') }; });
  app.post('/v1/identity/email/confirm', async req => { const { userId } = identityUser(req); const b = parse(z.object({ challengeId: z.string().min(10).max(64), code: z.string().min(4).max(12) }), req.body); deps.identity.confirmEmail(userId, b.challengeId, b.code); return deps.identity.describe(userId); });
  app.post('/v1/identity/phone/start', async (req, reply) => { const { userId } = identityUser(req); const b = parse(z.object({ phone: z.string().min(1).max(40) }), req.body); const r = await deps.identity.startPhoneVerification(userId, b.phone); void reply.code(201); return { ...r, devHint: devHint('sms') }; });
  app.post('/v1/identity/phone/confirm', async req => { const { userId } = identityUser(req); const b = parse(z.object({ challengeId: z.string().min(10).max(64), code: z.string().min(4).max(12) }), req.body); deps.identity.confirmPhone(userId, b.challengeId, b.code); return deps.identity.describe(userId); });

  // Endereço de liquidação adicional: exige sessão de identidade + PROVA DE POSSE (assinatura de
  // desafio) na própria rede do endereço (§3.2). Reusa o verificador do WalletAuth (fail closed).
  app.post('/v1/identity/settlement-address', async (req, reply) => {
    const { userId } = identityUser(req);
    const b = parse(z.object({ network: NetworkZ, address: z.string().min(8).max(120), nonce: z.string().min(8), signature: z.string().min(20), issuedAt: z.string().optional(), expiresAt: z.string().optional() }), req.body);
    const proof = await deps.auth.verify(b.network, b.address, b.nonce, b.signature, b.issuedAt, b.expiresAt); // lança se inválida
    deps.identity.addSettlementAddress(userId, caip10Of(proof.session), true);
    await deps.audit.append({ actorType: 'user', actorId: userId, category: 'identity.wallet.linked', dealId: null, payload: { network: b.network } });
    void reply.code(201); return deps.identity.describe(userId);
  });

  /* ---------- Salas de operação e convites (§5) ---------- */
  const roomActor = (req: FastifyRequest): RoomActor => { const { session, userId } = identityUser(req); return { userId, network: session.network, address: session.address }; };
  const InviteRoleZ = z.enum(INVITABLE_ROLES);

  app.get('/v1/rooms/openapi.json', async () => identityOpenApi(deps.env)); // spec unificada (identidade + salas)
  app.post('/v1/rooms', async (req, reply) => { const a = roomActor(req); const v = deps.rooms.createRoom(a); void reply.code(201); return v; });
  app.get('/v1/rooms/:id', async req => { const a = roomActor(req); const { id } = req.params as { id: string }; return deps.rooms.getView(id, a.userId); });
  app.post('/v1/rooms/:id/terms', async req => { const a = roomActor(req); const { id } = req.params as { id: string }; const b = parse(z.object({ version: z.number().int().min(1), termsHash: z.string().length(64) }), req.body); return deps.rooms.setTerms(id, a, b); });
  // Convite: resposta idêntica exista ou não a conta (anti-enumeração). Token opaco entregue ao PM01.
  app.post('/v1/rooms/:id/invites', async (req, reply) => { const a = roomActor(req); const { id } = req.params as { id: string }; const b = parse(z.object({ role: InviteRoleZ, email: z.string().max(200).optional(), phone: z.string().max(40).optional() }), req.body); const r = deps.rooms.invite(id, a, b); void reply.code(201); return r; });
  app.post('/v1/rooms/:id/invites/revoke', async req => { const a = roomActor(req); const { id } = req.params as { id: string }; const b = parse(z.object({ role: InviteRoleZ }), req.body); return deps.rooms.revoke(id, a, b.role); });
  // Token no CORPO (nunca em URL/query): o frontend lê o fragmento (#t=) e envia por POST.
  app.post('/v1/rooms/invite/resolve', async req => { const a = roomActor(req); const b = parse(z.object({ token: z.string().min(20).max(200) }), req.body); return deps.rooms.resolveInvite(b.token, a); });
  app.post('/v1/rooms/accept', async (req, reply) => { const a = roomActor(req); const b = parse(z.object({ token: z.string().min(20).max(200), nonce: z.string().min(8).max(64), signature: z.string().min(20).max(400) }), req.body); const v = await deps.rooms.acceptInvite(b.token, b.nonce, b.signature, a); void reply.code(201); return v; });
  app.post('/v1/rooms/:id/close', async req => { const a = roomActor(req); const { id } = req.params as { id: string }; const b = parse(z.object({ reason: z.string().min(3).max(200) }), req.body); return deps.rooms.close(id, a, b.reason); });
  // Ticket de WS de uso único (TTL 30s) — obtido por POST autenticado; nunca token de sessão em query.
  app.post('/v1/rooms/:id/ws-ticket', async (req, reply) => { const a = roomActor(req); const { id } = req.params as { id: string }; const t = deps.rooms.issueWsTicket(id, a); void reply.code(201); return t; });

  // WebSocket da sala: ticket via subprotocolo (fora da URL/logs), validação de Origin, autorização por sala.
  app.get('/v1/rooms/:id/stream', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    if (!deps.rooms.validateOrigin(req.headers.origin)) { socket.close(4403, 'origin inválida'); return; }
    // Ticket no header Sec-WebSocket-Protocol ("verum-ticket,<ticket>"); query aceita só como fallback.
    const proto = String(req.headers['sec-websocket-protocol'] ?? '');
    const fromProto = proto.split(',').map(s => s.trim()).find(s => s && s !== 'verum-ticket');
    const ticket = fromProto || String((req.query as { ticket?: string }).ticket ?? '');
    let ctx: { roomId: string; userId: string };
    try { ctx = deps.rooms.consumeWsTicket(ticket); deps.rooms.authorizeRoomMessage(id, ctx.userId); } catch { socket.close(4401, 'ticket inválido'); return; }
    if (ctx.roomId !== id) { socket.close(4401, 'ticket de outra sala'); return; }
    const onRoom = (ev: { roomId: string; type: string }) => { if (ev.roomId !== id) return; try { socket.send(JSON.stringify(ev)); } catch { /* socket fechando */ } if (ev.type === 'closed') socket.close(4410, 'sala encerrada'); };
    deps.rooms.events.on('room', onRoom);
    const ping = setInterval(() => { try { socket.ping(); } catch { /* ignore */ } }, 15_000);
    socket.on('message', (raw: Buffer) => {
      const m = WsClientMessage.safeParse((() => { try { return JSON.parse(raw.toString()); } catch { return null; } })());
      if (!m.success) { socket.close(4400, 'mensagem inválida'); return; }
      try { deps.rooms.authorizeRoomMessage(id, ctx.userId); } catch { socket.close(4410, 'sala indisponível'); return; }
      if (m.data.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });
    socket.on('close', () => { clearInterval(ping); deps.rooms.events.off('room', onRoom); });
    socket.send(JSON.stringify({ type: 'subscribed', roomId: id }));
  });

  /* ---------- ativos ---------- */
  app.get('/v1/assets', async req => { requireSession(req); return deps.registry.list().filter(a => a.status === 'active').map(a => ({ code: a.code, network: a.network, chainId: a.chainId, contractOrMint: a.contractOrMint, assetId: a.assetId, decimals: a.decimals, tokenStandard: a.tokenStandard, issuer: a.issuer })); });

  /* ---------- deals ---------- */
  app.post('/v1/deals', async (req, reply) => { const s = requireSession(req); const r = await idempotent(req, reply, async () => { const d = await deps.deals.create(req.body, s.address); return deps.deals.view(d, s.address); }); void reply.code(201); return r; });
  app.get('/v1/deals', async req => { const s = requireSession(req); const list = await deps.store.listDeals(s.role === 'operator' ? {} : { participant: s.address }); return list.map(short); });
  app.get('/v1/deals/:id', async req => { const s = requireSession(req); const { id } = req.params as { id: string }; const d = await deps.deals.get(id); return deps.deals.view(d, s.address, s.role === 'operator'); });
  app.get('/v1/deals/:id/timeline', async req => { const s = requireSession(req); const { id } = req.params as { id: string }; const d = await deps.deals.get(id); deps.deals.view(d, s.address, s.role === 'operator'); return deps.store.listDealEvents(id); });
  app.post('/v1/deals/:id/participants/:role/bind', async (req, reply) => { const s = requireSession(req); const { id, role } = req.params as { id: string; role: Role }; return idempotent(req, reply, async () => deps.deals.view(await deps.deals.connectWallet(id, parse(RoleZ, role), s.address, s.address), s.address)); });
  app.post('/v1/deals/:id/verify', async (req, reply) => { const s = requireSession(req); const { id } = req.params as { id: string }; return idempotent(req, reply, async () => deps.deals.view(await deps.deals.verify(id, s.address), s.address)); });
  app.post('/v1/deals/:id/open', async (req, reply) => { const s = requireSession(req); const { id } = req.params as { id: string }; return idempotent(req, reply, async () => deps.deals.view(await deps.deals.open(id, s.address), s.address)); });
  /* ---------- pré-visualização (somente leitura; o backend recalcula tudo na verificação da Deal) ---------- */
  app.get('/v1/quote', async req => { requireSession(req); const q = parse(z.object({ assetIn: z.string(), assetOut: z.string(), amountInBase: z.string().regex(/^[1-9][0-9]*$/), discountBps: z.coerce.number().int().min(0).max(2000).default(0), commissionBps: z.coerce.number().int().min(0).max(5000).default(0), maxSlippageBps: z.coerce.number().int().min(1).max(1000).default(50) }), req.query);
    const assetIn = deps.registry.resolveByAssetId(q.assetIn), assetOut = deps.registry.resolveByAssetId(q.assetOut); const snapshot = await deps.price.quote([assetIn.assetId, assetOut.assetId]);
    const econ = deps.price.computeEconomics({ assetIn, assetOut, amountInBase: q.amountInBase, snapshot, discountBps: q.discountBps, commissionBps: q.commissionBps, platformFeeBps: deps.platformFeeBps, paymasterShareBps: 0, maxSlippageBps: q.maxSlippageBps, maxPriceDriftBps: 100, networkCostUsd: { in: await deps.networkCostUsd(assetIn.network), out: await deps.networkCostUsd(assetOut.network) } });
    return { snapshot, pricing: econ.pricing, amountOutBase: econ.amountOutBase, feeBase: econ.feeBase }; });
  app.get('/v1/liquidity', async req => { requireSession(req); const q = parse(z.object({ assetIn: z.string(), assetOut: z.string(), amountInBase: z.string().regex(/^[1-9][0-9]*$/), maxSlippageBps: z.coerce.number().int().min(1).max(1000).default(50) }), req.query);
    const assetIn = deps.registry.resolveByAssetId(q.assetIn), assetOut = deps.registry.resolveByAssetId(q.assetOut); const snapshot = await deps.price.quote([assetIn.assetId, assetOut.assetId]); const sizeUsd = Number(BigInt(q.amountInBase)) / 10 ** assetIn.decimals * (snapshot.reference[assetIn.assetId] ?? 0);
    return deps.liquidity.assess({ assetIn, assetOut, sizeUsd, maxSlippageBps: q.maxSlippageBps }); });
  app.get('/v1/routes', async req => { requireSession(req); const q = parse(z.object({ assetIn: z.string(), assetOut: z.string(), participants: z.string().default('[]'), expiresInSec: z.coerce.number().int().min(60).default(3600) }), req.query);
    const assetIn = deps.registry.resolveByAssetId(q.assetIn), assetOut = deps.registry.resolveByAssetId(q.assetOut); const parts = parse(z.array(z.object({ network: NetworkZ, address: z.string().optional() })), JSON.parse(q.participants));
    return deps.router.plan({ assetIn, assetOut, participants: parts.map((p, i) => ({ role: (['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2'] as const)[i] ?? 'PAYMASTER_2', network: p.network, chainId: '', address: p.address ?? '', keyScheme: NETWORK_KEY_SCHEME[p.network] })), expiresInSec: q.expiresInSec }); });
  app.patch('/v1/deals/:id/terms', async (req, reply) => { const s = requireSession(req); const { id } = req.params as { id: string }; const b = parse(z.object({ discountBps: z.number().int().min(0).max(2000).optional(), commissionBps: z.number().int().min(0).max(5000).optional(), commissionSplitBps: z.array(z.number().int().min(0)).max(2).optional(), amountInBase: z.string().regex(/^[1-9][0-9]*$/).optional(), expiresInSec: z.number().int().min(900).max(86400).optional() }), req.body); return idempotent(req, reply, async () => deps.deals.view(await deps.deals.amend(id, b, s.address), s.address)); });
  app.post('/v1/deals/:id/legs/:idx/deposit', async (req, reply) => { const s = requireSession(req); const { id, idx } = req.params as { id: string; idx: string }; const d = await deps.deals.get(id); const leg = d.terms?.legs[Number(idx)]; if (!leg) throw new DomainError('INVALID_INPUT', 'leg inexistente'); return idempotent(req, reply, async () => deps.deals.view(await deps.deals.fund(id, leg.from, s.address), s.address)); });
  /* ---------- Propostas estruturadas de alteração de termos (§5.3/§6) ---------- */
  // Mudança tipada e validada (nunca texto livre). Aplicar aciona o amend: version++ invalida
  // todas as assinaturas e a operação retorna a AWAITING_SIGNATURES para reassinatura.
  app.post('/v1/deals/:id/proposals', async (req, reply) => { const s = requireSession(req); const { id } = req.params as { id: string }; const change = parse(ProposalChangeZ, req.body); const r = await deps.proposals.propose(id, s.address, change); void reply.code(201); return r; });
  app.get('/v1/deals/:id/proposals', async req => { const s = requireSession(req); const { id } = req.params as { id: string }; return deps.proposals.list(id, s.address); });
  app.post('/v1/deals/:id/proposals/:pid/apply', async (req, reply) => { const s = requireSession(req); const { id, pid } = req.params as { id: string; pid: string }; return idempotent(req, reply, async () => deps.deals.view(await deps.proposals.apply(id, pid, s.address), s.address)); });
  app.post('/v1/deals/:id/proposals/:pid/withdraw', async req => { const s = requireSession(req); const { id, pid } = req.params as { id: string; pid: string }; return deps.proposals.withdraw(id, pid, s.address); });
  app.post('/v1/deals/:id/proposals/:pid/reject', async req => { const s = requireSession(req); const { id, pid } = req.params as { id: string; pid: string }; return deps.proposals.reject(id, pid, s.address); });
  app.get('/v1/deals/:id/approval-envelope', async req => { const s = requireSession(req); const { id } = req.params as { id: string }; const d = await deps.deals.get(id); const me = d.participants.find(p => p.address.toLowerCase() === s.address.toLowerCase()); if (!me) throw new DomainError('NOT_PARTICIPANT', 'não é participante'); const env = await deps.deals.envelope(id, me.role, s.address); return { scheme: env.scheme, network: env.network, payload: env.payload, message: env.message, typedData: env.typedData ? { ...env.typedData, message: Object.fromEntries(Object.entries(env.typedData.message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) } : undefined }; });
  app.post('/v1/deals/:id/approvals', async (req, reply) => { const s = requireSession(req); const { id } = req.params as { id: string }; const b = parse(z.object({ role: RoleZ, signature: z.string().min(20), nonce: z.string().min(8) }), req.body); return idempotent(req, reply, async () => { const r = await deps.deals.submitSignature(id, { role: b.role, signer: s.address, scheme: s.keyScheme, signature: b.signature, nonce: b.nonce }, s.address); return { count: r.count, required: r.deal.requiredSignatures, state: r.deal.state }; }); });
  /**
   * Fluxo de CARTEIRA REAL (escrow canônico Verum): o passo on-chain da vez do participante.
   * GET devolve o que assinar/enviar (EVM/Tron: approve pendente + typedData Approval; Solana: tx base64).
   * POST devolve o relay (PMs), o txRequest/params p/ a carteira enviar (seller/buyer) ou faz o
   * broadcast da tx Solana assinada. Em modo simulado/dev-keyring o endpoint responde 400.
   */
  /** Adapter do passo on-chain: a primeira leg cuja rede expõe participant-steps (na rota HTLC a
   *  legs[0] é a BTC externa — o passo do participante vive na leg de CONTRATO). */
  const stepAdapterOf = (d: Deal) => {
    for (const leg of d.terms?.legs ?? []) { const a = deps.adapters?.get(leg.escrowChain); if (a && hasParticipantSteps(a)) return a; }
    throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'rede em modo simulado — o passo on-chain é automático');
  };
  app.get('/v1/deals/:id/onchain-tx', async req => {
    const s = requireSession(req); const { id } = req.params as { id: string };
    const d = await deps.deals.get(id);
    const me = d.participants.find(p => p.address.toLowerCase() === s.address.toLowerCase());
    if (!me) throw new DomainError('NOT_PARTICIPANT', 'não é participante');
    if (!d.terms?.legs.length) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos não congelados');
    return stepAdapterOf(d).buildParticipantStep(id, me.role, s.address);
  });
  app.post('/v1/deals/:id/onchain-tx', async (req, reply) => {
    const s = requireSession(req); const { id } = req.params as { id: string };
    const b = parse(z.object({ signature: z.string().optional(), deadline: z.number().int().optional(), signedTransactionBase64: z.string().optional() }), req.body);
    const d = await deps.deals.get(id);
    const me = d.participants.find(p => p.address.toLowerCase() === s.address.toLowerCase());
    if (!me) throw new DomainError('NOT_PARTICIPANT', 'não é participante');
    if (!d.terms?.legs.length) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'termos não congelados');
    const a = stepAdapterOf(d);
    return idempotent(req, reply, async () => a.submitParticipantStep(id, me.role, s.address, b as Record<string, unknown>));
  });

  app.post('/v1/deals/:id/cancel', async (req, reply) => { const s = requireSession(req); const { id } = req.params as { id: string }; return idempotent(req, reply, async () => deps.deals.view(await deps.deals.cancel(id, s.address), s.address)); });
  app.get('/v1/deals/:id/settlement', async req => { const s = requireSession(req); const { id } = req.params as { id: string }; const d = await deps.deals.get(id); deps.deals.view(d, s.address, s.role === 'operator'); return deps.store.getSettlement(id); });
  /** Permissionless: qualquer participante pode pedir que o keeper relaye o settle (o contrato decide). */
  app.post('/v1/deals/:id/settle', async (req, reply) => { const s = requireSession(req); const { id } = req.params as { id: string }; const d = await deps.deals.get(id); deps.deals.view(d, s.address, s.role === 'operator'); return idempotent(req, reply, async () => deps.settlement.settle(id, `user:${s.sub}`)); });
  app.get('/v1/deals/:id/receipt', async req => { const s = requireSession(req); const { id } = req.params as { id: string }; const d = await deps.deals.get(id); const v = deps.deals.view(d, s.address, s.role === 'operator'); return { dealId: d.id, revision: d.revision, state: d.state, dealHash: d.hash?.dealHash ?? null, terms: d.terms, signatures: v.signatures, settlement: await deps.store.getSettlement(id), refunds: d.refunds, events: await deps.store.listDealEvents(id) }; });

  /* ---------- SSE + WebSocket ---------- */
  app.get('/v1/deals/:id/events', async (req, reply) => {
    const s = requireSession(req); const { id } = req.params as { id: string }; const d = await deps.deals.get(id); deps.deals.view(d, s.address, s.role === 'operator');
    if ((streams.get(s.sub) ?? 0) >= MAX_STREAMS_PER_SESSION) throw new DomainError('INVALID_INPUT', 'Limite de streams por sessão atingido'); streams.set(s.sub, (streams.get(s.sub) ?? 0) + 1); metrics.sseConnections.inc();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (ev: DealEventMsg) => { if (ev.dealId === id) reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(short(d))}\n\n`); deps.deals.events.on('deal', send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(ping); deps.deals.events.off('deal', send); streams.set(s.sub, Math.max(0, (streams.get(s.sub) ?? 1) - 1)); metrics.sseConnections.dec(); });
    await new Promise<void>(resolve => req.raw.on('close', resolve));
  });
  app.get('/v1/ws', { websocket: true }, (socket, req) => {
    const s = deps.auth.parse(String((req.query as { token?: string }).token ?? '')); if (!s) { socket.close(4401, 'sessão inválida'); return; }
    const subs = new Set<string>();
    const send = (ev: DealEventMsg) => { if (subs.has(ev.dealId)) socket.send(JSON.stringify(ev)); };
    deps.deals.events.on('deal', send);
    socket.on('message', (raw: Buffer) => { void (async () => { try { const m = JSON.parse(raw.toString()) as { subscribe?: string }; if (m.subscribe) { const d = await deps.deals.get(m.subscribe); deps.deals.view(d, s.address, s.role === 'operator'); subs.add(m.subscribe); socket.send(JSON.stringify({ type: 'subscribed', dealId: m.subscribe, state: d.state })); } } catch (e) { socket.send(JSON.stringify({ type: 'error', message: (e as Error).message })); } })(); });
    socket.on('close', () => deps.deals.events.off('deal', send));
  });

  /* ---------- backoffice ---------- */
  app.get('/ops/deals', async req => { requireOperator(req); return (await deps.store.listDeals()).map(short); });
  app.post('/ops/deals/:id/block', async (req, reply) => { const s = requireOperator(req); const { id } = req.params as { id: string }; const b = parse(z.object({ reason: z.string().min(5).max(500) }), req.body); return idempotent(req, reply, async () => deps.deals.view(await deps.deals.block(id, b.reason, 'OPS · manual', `op:${s.sub}`), null, true)); });
  app.post('/ops/deals/:id/refund', async (req, reply) => { const s = requireOperator(req); const { id } = req.params as { id: string }; return idempotent(req, reply, async () => { await deps.audit.append({ actorType: 'operator', actorId: s.sub, category: 'ops.refund.retry', dealId: id, payload: {} }); return deps.deals.view(await deps.deals.retryRefunds(id), null, true); }); });
  app.get('/ops/price/breaker', async req => { requireOperator(req); return deps.price.breakerState(); });
  app.post('/ops/price/breaker/reset', async (req, reply) => { const s = requireOperator(req); return idempotent(req, reply, async () => { deps.price.resetBreaker(); await deps.audit.append({ actorType: 'operator', actorId: s.sub, category: 'ops.price.breaker.reset', dealId: null, payload: {} }); return deps.price.breakerState(); }); });
  app.get('/ops/risk/:id', async req => { requireOperator(req); const { id } = req.params as { id: string }; return deps.store.listRiskEvents(id); });
  app.get('/ops/audit/verify', async req => { requireOperator(req); const events = await deps.store.listAudit(100_000); return { ...AuditLog.verify(events), count: events.length }; });
  app.post('/ops/settlement/recover', async req => { requireOperator(req); return deps.settlement.recover(); });

  /* ---------- Portal Pay Master (cadastro, carteira, código de mesa) ---------- */
  const portalToken = (req: FastifyRequest): string | undefined => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
  app.post('/v1/portal/register', async (req, reply) => { const b = parse(z.object({ name: z.string().min(2).max(120), email: z.string().min(5).max(160), org: z.string().max(160).optional(), password: z.string().min(8).max(200) }), req.body); const r = deps.portal.register(b); await deps.audit.append({ actorType: 'user', actorId: r.payMaster.id, category: 'portal.register', dealId: null, payload: { email: r.payMaster.email } }); void reply.code(201); return r; });
  app.post('/v1/portal/login', async req => { const b = parse(z.object({ email: z.string().min(5).max(160), password: z.string().min(1).max(200) }), req.body); return deps.portal.login(b); });
  app.post('/v1/portal/logout', async req => { deps.portal.logout(portalToken(req)); return { ok: true }; });
  app.get('/v1/portal/me', async req => deps.portal.me(portalToken(req)));

  /* ---------- Segurança da mesa (2FA TOTP, bloqueio por inatividade, alerta de carteira) — enforcement no backend ---------- */
  app.get('/v1/portal/security', async req => deps.portal.getSecurity(portalToken(req)));
  app.put('/v1/portal/security', async req => { const b = parse(z.object({ idleLock: z.object({ enabled: z.boolean().optional(), timeoutMinutes: z.number().int().min(1).max(240).optional() }).optional(), newWalletAlert: z.object({ enabled: z.boolean().optional() }).optional() }), req.body ?? {}); return deps.portal.updateSecurity(portalToken(req), b); });
  app.post('/v1/portal/security/2fa/begin', async (req, reply) => { const r = deps.portal.begin2FA(portalToken(req)); await deps.audit.append({ actorType: 'user', actorId: 'portal', category: 'portal.2fa.begin', dealId: null, payload: {} }); void reply.code(201); return r; });
  app.post('/v1/portal/security/2fa/confirm', async req => { const b = parse(z.object({ code: z.string().min(6).max(12) }), req.body); const r = deps.portal.confirm2FA(portalToken(req), b.code); await deps.audit.append({ actorType: 'user', actorId: 'portal', category: 'portal.2fa.enabled', dealId: null, payload: {} }); return r; });
  app.post('/v1/portal/security/2fa/disable', async req => { const b = parse(z.object({ code: z.string().min(6).max(12) }), req.body); const r = deps.portal.disable2FA(portalToken(req), b.code); await deps.audit.append({ actorType: 'user', actorId: 'portal', category: 'portal.2fa.disabled', dealId: null, payload: {} }); return r; });
  app.get('/v1/portal/alerts', async req => deps.portal.listAlerts(portalToken(req)));
  app.post('/v1/portal/alerts/read', async req => { deps.portal.markAlertsRead(portalToken(req)); return { ok: true }; });
  app.post('/v1/portal/wallet/connect', async req => { const b = parse(z.object({ address: z.string().min(8).max(120), network: z.string().min(2).max(40), addresses: WalletAddressesZ }), req.body); return deps.portal.connectWallet(portalToken(req), b); });
  app.post('/v1/portal/wallet/disconnect', async req => { deps.portal.disconnectWallet(portalToken(req)); return { ok: true }; });
  app.post('/v1/portal/mesa/code', async (req, reply) => { const r = deps.portal.generateCode(portalToken(req)); void reply.code(201); return r; });
  app.get('/v1/portal/mesa/code', async req => ({ code: deps.portal.currentCode(portalToken(req)) }));
  app.get('/v1/portal/mesa/code/:code', async req => { const { code } = req.params as { code: string }; const r = deps.portal.resolveCode(code); if (!r) throw new DomainError('INVALID_INPUT', 'Código inválido ou expirado'); return r; });

  /* ---------- Convites de carteira por papel (link enviado pelo PM) ---------- */
  const MesaRoleZ = z.enum(['SELLER', 'BUYER', 'PAYMASTER_2']);
  // PM autenticado gera um link de convite para um papel.
  app.post('/v1/portal/mesa/invites', async (req, reply) => { const b = parse(z.object({ role: MesaRoleZ, network: z.string().min(2).max(40), label: z.string().max(120).optional() }), req.body); const inv = deps.portal.createInvite(portalToken(req), b); await deps.audit.append({ actorType: 'user', actorId: 'portal', category: 'portal.invite.create', dealId: null, payload: { role: b.role } }); void reply.code(201); return inv; });
  // PM autenticado lê os 4 slots da mesa (polling do painel).
  app.get('/v1/portal/mesa', async req => deps.portal.listMesa(portalToken(req)));

  // ---- Operação (Deal real) a partir da mesa: cria no DealEngine e expõe o estado vivo p/ a esteira ----
  // No modo EVM inclui o contrato de liquidação e as transferências (txids reais) p/ o painel do frontend.
  const mesaDealView = async (d: Deal) => {
    const ev = deps.dev?.evm ?? null;
    const legs = d.terms?.legs ?? [];
    const rec = d.settlement ?? (legs.length && ['SETTLEMENT_VALIDATION', 'SETTLING', 'SETTLED', 'BLOCKED', 'REFUNDING', 'REFUNDED'].includes(d.state) ? await deps.store.getSettlement(d.id).catch(() => null) : null);
    const legLabel = (i: number) => { const leg = legs.find(l => l.index === i); return leg ? `${leg.asset.code} → carteira do ${leg.to === 'SELLER' ? 'Vendedor' : 'Comprador'}` : `Transferência ${i}`; };
    return {
      id: d.id, state: d.state, createdAt: d.createdAt, amountInBase: d.draft?.amountInBase ?? null, requiredSignatures: d.requiredSignatures, validSignatures: d.validSignatures,
      turnRole: d.turnRole ?? null, turnExpiresAt: d.turnExpiresAt ?? null, expiresAt: d.expiresAt,
      signed: d.signatures.filter(s => s.status === 'valid' && s.revision === d.revision).map(s => s.role),
      participants: d.participants.map(p => ({ role: p.role, address: p.address })),
      settlementMode: ev ? 'evm' as const : 'local' as const,
      demo: !!(deps.dev?.demo && d.participants.some(p => deps.dev!.demo!.addresses.has(p.address))),
      escrowContract: legs[0]?.escrowContract ?? null, escrowChainId: ev?.chainId ?? null, explorerBase: ev?.explorerBase ?? null,
      pair: { in: { code: d.draft.assetIn.code, decimals: d.draft.assetIn.decimals, amountBase: d.draft.amountInBase }, out: { code: d.draft.assetOut.code, decimals: d.draft.assetOut.decimals, amountBase: legs[1]?.amountBase ?? null } },
      settlement: rec ? { status: rec.status, legs: rec.legs.map(l => ({ index: l.index, label: legLabel(l.index), txRef: l.txRef, step: l.step, confirmations: l.confirmations })) } : null
    };
  };
  /** Corpo aceito na criação da operação da mesa (legada e v3). */
  const MesaDealBodyZ = z.object({ amountInBase: z.string().regex(/^[1-9][0-9]*$/).optional(), discountBps: z.coerce.number().int().min(0).max(2000).default(300), commissionBps: z.coerce.number().int().min(0).max(5000).default(200), commissionSplitBps: z.array(z.number().int().min(0)).max(2).default([]), maxSlippageBps: z.coerce.number().int().min(1).max(1000).default(50), expiresInSec: z.coerce.number().int().min(900).max(10 * 86400).default(4 * 48 * 3600), twoFactorCode: z.string().max(12).optional() });
  type MesaDealBody = z.infer<typeof MesaDealBodyZ>;
  /** Criação da Deal a partir dos participantes da mesa (fatorada: usada pela mesa legada e pelo approve v3). */
  const createMesaDealForParts = async (parts: { role: Role; address: string }[], b: MesaDealBody, onCreated: (dealId: string) => void) => {
    if (!deps.dev) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Criação de operação da mesa está disponível apenas em ambiente de desenvolvimento');
    const seller = parts.find(p => p.role === 'SELLER'); if (!seller) throw new DomainError('INVALID_INPUT', 'Mesa sem Vendedor');
    // ── Modo EVM: deal REAL no VerumOtcEscrow (Sepolia/anvil). Vendedor entrega tUSDT (leg 0 → Comprador);
    // Comprador paga tBTC (leg 1 → Vendedor). EOAs dev derivadas por dono do slot; depósitos on-chain de verdade.
    if (deps.dev.evm) {
      const ev = deps.dev.evm;
      const evmParts = parts.map(p => ({ role: p.role, network: 'ethereum', chainId: ev.chainId, address: ev.keyring.addressFor(p.address) }));
      const sellerEvm = evmParts.find(p => p.role === 'SELLER') as { role: Role; address: string }; const buyerEvm = evmParts.find(p => p.role === 'BUYER');
      // teto dev: mantém o valor abaixo do limite de risco (MAX_DEAL_USD) — tUSDT tem 6 casas
      const amountInBase = String(BigInt(b.amountInBase ?? '50000000000') > 80_000_000_000n ? 80_000_000_000n : BigInt(b.amountInBase ?? '50000000000'));
      await ev.mintToken(ev.tusdt, sellerEvm.address, BigInt(amountInBase) * 2n);      // tUSDT p/ o Vendedor depositar (verify checa saldo)
      if (buyerEvm) await ev.mintToken(ev.tbtc, buyerEvm.address, 10n ** 12n);         // 10.000 tBTC — folga p/ amountOut + comissão
      const input = { assetIn: { network: 'ethereum', chainId: ev.chainId, contractOrMint: ev.tusdt }, assetOut: { network: 'ethereum', chainId: ev.chainId, contractOrMint: ev.tbtc }, amountInBase, discountBps: b.discountBps, commissionBps: b.commissionBps, commissionSplitBps: b.commissionSplitBps, maxSlippageBps: b.maxSlippageBps, maxPriceDriftBps: 100, expiresInSec: b.expiresInSec, participants: evmParts };
      const created = await deps.deals.create(input, sellerEvm.address);
      for (const p of evmParts) await deps.deals.connectWallet(created.id, p.role, p.address, p.address); // último connect congela termos + register() on-chain
      await deps.deals.open(created.id, sellerEvm.address);
      try { await deps.deals.fund(created.id, 'SELLER', sellerEvm.address); if (buyerEvm) await deps.deals.fund(created.id, 'BUYER', buyerEvm.address); } catch (e) { logger.warn({ dealId: created.id, err: (e as Error).message }, 'auto-funding EVM dev falhou'); }
      onCreated(created.id);
      await deps.audit.append({ actorType: 'user', actorId: sellerEvm.address, category: 'portal.mesa.deal.created', dealId: created.id, payload: { participants: parts.length, mode: 'evm', chainId: ev.chainId } });
      return mesaDealView(await deps.deals.get(created.id));
    }
    const chainId = deps.dev.solanaChainId;
    const usdc = deps.registry.list().find(a => a.code === 'USDC' && a.network === 'solana'); if (!usdc) throw new DomainError('ASSET_NOT_CANONICAL', 'USDC (Solana) ausente no registro');
    const amountInBase = b.amountInBase ?? '100000000000'; // 100 SOL (demo dev)
    const input = { assetIn: { network: 'solana', chainId, contractOrMint: null }, assetOut: { network: 'solana', chainId, contractOrMint: usdc.contractOrMint }, amountInBase, discountBps: b.discountBps, commissionBps: b.commissionBps, commissionSplitBps: b.commissionSplitBps, maxSlippageBps: b.maxSlippageBps, maxPriceDriftBps: 100, expiresInSec: b.expiresInSec, participants: parts.map(p => ({ role: p.role, network: 'solana', chainId, address: p.address })) };
    const buyer = parts.find(p => p.role === 'BUYER');
    const created = await deps.deals.create(input, seller.address);
    deps.dev.mint(seller.address, null, BigInt(amountInBase) * 2n);            // SOL p/ o Vendedor depositar
    if (buyer) deps.dev.mint(buyer.address, usdc.contractOrMint, 10n ** 15n);  // USDC p/ o Comprador depositar
    for (const p of parts) await deps.deals.connectWallet(created.id, p.role, p.address, p.address); // último connect verifica e congela termos
    const opened = await deps.deals.open(created.id, seller.address); // → AWAITING_SIGNATURES (turno do Vendedor)
    // Financiamento automático (dev) p/ liberar as assinaturas — em prod cada depositante financia pela própria carteira.
    try { await deps.deals.fund(created.id, 'SELLER', seller.address); if (buyer) await deps.deals.fund(created.id, 'BUYER', buyer.address); } catch (e) { logger.warn({ dealId: created.id, err: (e as Error).message }, 'auto-funding dev falhou'); }
    onCreated(created.id);
    await deps.audit.append({ actorType: 'user', actorId: seller.address, category: 'portal.mesa.deal.created', dealId: created.id, payload: { participants: parts.length } });
    return mesaDealView(opened);
  };
  /**
   * Criação da Deal HTLC REAL a partir das CADEIRAS da mesa (v4): vendedor entrega BTC NATIVO
   * (lock no HTLC P2WSH da rede Bitcoin) e o comprador deposita o token no escrow V2 da perna
   * EVM. Usa os endereços MULTICHAIN das carteiras conectadas — cada papel na rede da sua perna.
   * O funding do vendedor é o lock externo: o fund devolve FUNDING_REQUIRED com o endereço do
   * cofre, exposto na resposta (`htlcFunding`) para a UI instruir a carteira.
   */
  const createMesaHtlcDeal = async (mesa: MesaRecord, b: MesaDealBody, onCreated: (dealId: string) => void) => {
    const adapters = deps.adapters;
    if (!adapters) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Operação HTLC indisponível: adaptadores de rede não configurados');
    const plan = deriveSettlementPlan(mesa.chairs);
    if (plan?.mode !== 'HTLC_BTC') throw new DomainError('INVALID_INPUT', 'Mesa sem perna de BTC nativo');
    if (plan.htlc?.btcSide !== 'SELLER') throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'BTC nativo do lado COMPRADOR ainda não é suportado (a perna externa do escrow V2 é a do vendedor)');
    const sellerChair = mesa.chairs.find(c => c.role === 'SELLER') as MesaChair;
    const buyerChair = mesa.chairs.find(c => c.role === 'BUYER') as MesaChair;
    const pm1Chair = mesa.chairs.find(c => c.role === 'PAYMASTER_1');
    if (!pm1Chair?.wallet) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Operação HTLC pela mesa exige a cadeira Pay Master 1 conectada (o motor pede no mínimo 3 papéis)');
    const tokenNet = buyerChair.expectedAsset.network;
    if (tokenNet !== 'ethereum') throw new DomainError('SETTLEMENT_NOT_ALLOWED', `Perna de contrato em ${tokenNet} ainda não é suportada no fluxo HTLC da mesa (comece por Ethereum/Sepolia)`);
    const btcAdapter = adapters.get('bitcoin'); const evmAdapter = adapters.get('ethereum');
    if (!btcAdapter || !evmAdapter) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Adaptadores bitcoin/ethereum ausentes');
    // Endereços por perna, vindos da carteira multichain de cada cadeira.
    const motivos: string[] = [];
    const sellerBtc = addressOn(sellerChair, 'bitcoin'); if (!sellerBtc || !btcAdapter.validateAddress(sellerBtc)) motivos.push('Vendedor: carteira sem endereço Bitcoin válido');
    const buyerEvm = addressOn(buyerChair, 'ethereum'); if (!buyerEvm || !evmAdapter.validateAddress(buyerEvm)) motivos.push('Comprador: carteira sem endereço Ethereum válido');
    const pm1Evm = addressOn(pm1Chair, 'ethereum'); if (!pm1Evm || !evmAdapter.validateAddress(pm1Evm)) motivos.push('Pay Master 1: carteira sem endereço Ethereum válido');
    if (!mesa.config?.amountInBase) motivos.push('Configuração: quantidade do Vendedor (sats) não definida');
    if (motivos.length) throw new DomainError('VERSION_CONFLICT', 'Não foi possível criar a operação HTLC', { motivos });
    const input = {
      assetIn: { network: 'bitcoin', chainId: btcAdapter.chain.chainId, contractOrMint: null },
      assetOut: { network: 'ethereum', chainId: evmAdapter.chain.chainId, contractOrMint: buyerChair.expectedAsset.contractOrMint },
      amountInBase: mesa.config!.amountInBase as string, discountBps: b.discountBps, commissionBps: b.commissionBps, commissionSplitBps: b.commissionSplitBps,
      maxSlippageBps: b.maxSlippageBps, maxPriceDriftBps: 500, expiresInSec: b.expiresInSec,
      participants: [
        { role: 'SELLER', network: 'bitcoin', chainId: btcAdapter.chain.chainId, address: sellerBtc },
        { role: 'PAYMASTER_1', network: 'ethereum', chainId: evmAdapter.chain.chainId, address: pm1Evm },
        { role: 'BUYER', network: 'ethereum', chainId: evmAdapter.chain.chainId, address: buyerEvm },
      ],
    };
    const created = await deps.deals.create(input, sellerBtc as string);
    // Linka a deal à mesa ANTES do open: o registro on-chain (dentro do open) resolve o endereço
    // EVM do vendedor-BTC pela carteira multichain da cadeira — a busca é por mesa.dealId(s).
    onCreated(created.id);
    for (const p of input.participants) if (p.role !== 'SELLER') await deps.deals.connectWallet(created.id, p.role as Role, p.address as string, p.address as string);
    await deps.deals.open(created.id, sellerBtc as string); // registra: createTradeV2 (EVM) + derivação do cofre (BTC)
    // Funding: comprador (approve ERC-20 — melhor esforço: carteira real completa via /onchain-tx);
    // vendedor é o LOCK EXTERNO — o fund devolve o endereço do cofre, que vai na resposta.
    let htlcFunding: { address: string; requiredSat: string } | null = null;
    try { await deps.deals.fund(created.id, 'BUYER', buyerEvm as string); } catch (e) { logger.warn({ dealId: created.id, err: (e as Error).message }, 'funding do comprador pendente (carteira real completa via /onchain-tx)'); }
    try { await deps.deals.fund(created.id, 'SELLER', sellerBtc as string); }
    catch (e) {
      const err = e as DomainError;
      if (err.code === 'FUNDING_REQUIRED' && err.details?.address) htlcFunding = { address: String(err.details.address), requiredSat: String(err.details.requiredSat ?? mesa.config!.amountInBase) };
      else logger.warn({ dealId: created.id, err: err.message }, 'funding do vendedor pendente');
    }
    await deps.audit.append({ actorType: 'user', actorId: mesa.payMasterId, category: 'portal.mesa.deal.created', dealId: created.id, payload: { mode: 'htlc-btc', vault: htlcFunding?.address ?? null } });
    // Carteira real: o registro on-chain (createTradeV2) é enviado pela carteira do PM1 — o
    // txRequest vem no meta do adapter e vai na resposta para o dashboard disparar a assinatura.
    const dealNow = await deps.deals.get(created.id);
    const evmMeta = dealNow?.onChain?.ethereum?.meta as Record<string, unknown> | undefined;
    const registerTx = evmMeta?.registerPending && typeof evmMeta.registerTx === 'string' ? JSON.parse(evmMeta.registerTx) as Record<string, unknown> : null;
    // O cofre P2WSH é DETERMINÍSTICO (meta do registro BTC) — não depende do fund, que no fluxo
    // ordenado responde "leg de contrato primeiro" sem o endereço.
    if (!htlcFunding) {
      const btcMeta = dealNow?.onChain?.bitcoin?.meta as Record<string, unknown> | undefined;
      if (typeof btcMeta?.htlcAddress === 'string') htlcFunding = { address: btcMeta.htlcAddress, requiredSat: String(mesa.config!.amountInBase) };
    }
    return { ...await mesaDealView(dealNow), htlcFunding, registerTx };
  };

  app.post('/v1/portal/mesa/deal', async (req, reply) => {
    const token = portalToken(req);
    const b = parse(MesaDealBodyZ, req.body ?? {});
    deps.portal.require2FA(token, b.twoFactorCode); // 2FA (se ativo) exigido para assinar operações
    const parts = deps.portal.mesaParticipants(token);
    const view = await createMesaDealForParts(parts, b, id => deps.portal.setMesaDeal(token, id));
    void reply.code(201); return view;
  });
  app.get('/v1/portal/mesa/deal', async req => {
    const id = deps.portal.getMesaDeal(portalToken(req)); if (!id) return { deal: null };
    let d = await deps.deals.get(id).catch(() => null);
    // Cura deals presas (liquidação assíncrona cortada no serverless): re-hidrata o simulador
    // desta instância e liquida/retoma. `recover()` destrava registros EXECUTING órfãos.
    if (d && (d.state === 'SETTLEMENT_VALIDATION' || d.state === 'SETTLING')) {
      try { await deps.dev?.ensureOnChain?.(id); } catch { /* melhor esforço */ }
      try { if (d.state === 'SETTLEMENT_VALIDATION') await deps.settlement.settle(id, 'keeper'); else await deps.settlement.recover(); } catch { /* idempotente; falha vira BLOCKED */ }
      d = await deps.deals.get(id).catch(() => d);
    }
    return { deal: d ? await mesaDealView(d) : null };
  });
  // Assinatura da vez pela mesa (modo EVM dev): o backend assina o digest EIP-712 do turno atual com a
  // EOA dev do papel — todas as validações do Deal Engine (ordem, turno 5 min, nonce, cripto) permanecem.
  /** Assinatura do turno atual pela mesa (fatorada: mesa legada e mesa v3). */
  const signTurnOfDeal = async (id: string) => {
    const ev = deps.dev?.evm; const demo = deps.dev?.demo;
    if (!ev && !demo) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Assinatura pela mesa disponível apenas nos modos EVM/demo (dev)');
    const d = await deps.deals.get(id);
    const role = d.turnRole; if (!role) throw new DomainError('SETTLEMENT_NOT_ALLOWED', 'Nenhum turno de assinatura em aberto');
    const p = d.participants.find(x => x.role === role); if (!p) throw new DomainError('NOT_PARTICIPANT', 'papel da vez sem participante');
    // Resiliência serverless: se o auto-funding da criação falhou (timeout/RPC), retenta aqui —
    // sem isso o turno trava em FUNDING_REQUIRED mesmo com a carteira dev tendo saldo.
    if (p.fundingRequired && p.funding !== 'FINAL') await deps.deals.fund(id, role, p.address);
    const env = await deps.deals.envelope(id, role, p.address);
    let signature: string; let scheme: 'secp256k1' | 'ed25519';
    const evAcc = ev?.keyring.accountByAddress(p.address);
    const demoRole = demo?.keyring.roleOf(p.address);
    if (evAcc && env.typedData) {
      // Modo EVM: backend assina o digest EIP-712 com a EOA dev do papel.
      signature = await evAcc.signTypedData({ domain: env.typedData.domain, types: env.typedData.types, primaryType: 'DealApproval', message: env.typedData.message });
      scheme = 'secp256k1';
    } else if (demoRole && demoRole.network === 'solana') {
      // Conta DEMO: keypair Ed25519 do papel assina a mensagem do envelope (igual à Verum Wallet).
      signature = demo!.keyring.signMessage(demoRole.role, env.message);
      scheme = 'ed25519';
    } else {
      throw new DomainError('FORBIDDEN', 'carteira do papel não é gerida pelo keyring dev/demo');
    }
    // ANTES de submeter: re-hidrata o simulador desta instância. A última assinatura dispara o
    // listener de auto-liquidação imediatamente — se o simulador ainda não conhece a deal
    // (criada em outra instância), a validação bloquearia com FUNDING_REQUIRED.
    try { await deps.dev?.ensureOnChain?.(id); } catch { /* melhor esforço */ }
    const r = await deps.deals.submitSignature(id, { role, signer: p.address, scheme, signature, nonce: env.payload.nonce }, p.address);
    await deps.audit.append({ actorType: 'user', actorId: p.address, category: 'portal.mesa.deal.signed', dealId: id, payload: { role, count: r.count } });
    // Serverless: o listener assíncrono de auto-liquidação pode ser congelado após a resposta —
    // liquida INLINE (idempotente) quando a última assinatura destravou a validação. Antes,
    // re-hidrata o simulador desta instância (a deal pode ter sido criada em outra).
    let out = r.deal;
    if (out.state === 'SETTLEMENT_VALIDATION') {
      try { await deps.dev?.ensureOnChain?.(id); } catch { /* simulador re-hidratado no melhor esforço */ }
      try { await deps.settlement.settle(id, 'keeper'); } catch { /* rejeição vira BLOCKED/EXPIRED; o refetch reflete */ }
      out = await deps.deals.get(id).catch(() => out);
    }
    return mesaDealView(out);
  };
  app.post('/v1/portal/mesa/deal/sign', async req => {
    const token = portalToken(req);
    const b = parse(z.object({ twoFactorCode: z.string().max(12).optional() }), req.body ?? {});
    deps.portal.require2FA(token, b.twoFactorCode);
    const id = deps.portal.getMesaDeal(token); if (!id) throw new DomainError('INVALID_INPUT', 'Nenhuma operação ativa na mesa');
    return signTurnOfDeal(id);
  });
  // Histórico da mesa: todas as operações já criadas (mais recentes primeiro) + qual está ativa na esteira.
  app.get('/v1/portal/mesa/deals', async req => {
    const token = portalToken(req);
    const ids = deps.portal.getMesaDeals(token);
    const found = (await Promise.all(ids.map(id => deps.deals.get(id).catch(() => null)))).filter((d): d is Deal => d !== null);
    return { deals: await Promise.all(found.map(mesaDealView)), activeId: deps.portal.getMesaDeal(token) };
  });
  // Limpa o histórico da mesa (apresentações): só em dev ou na conta demo.
  app.post('/v1/portal/mesa/deals/clear', async req => {
    const token = portalToken(req);
    if (deps.env !== 'dev' && !deps.portal.isDemoSession(token)) throw new DomainError('FORBIDDEN', 'Limpeza de histórico disponível apenas em dev ou na conta demo');
    deps.portal.clearMesaDeals(token);
    await deps.audit.append({ actorType: 'user', actorId: 'portal', category: 'portal.mesa.deals.cleared', dealId: null, payload: {} });
    return { ok: true };
  });
  // Abre (torna ativa) uma operação do histórico — a esteira e a assinatura passam a apontar p/ ela.
  app.post('/v1/portal/mesa/deal/select', async req => {
    const token = portalToken(req);
    const b = parse(z.object({ dealId: z.string().min(4).max(60) }), req.body);
    deps.portal.selectMesaDeal(token, b.dealId);
    const d = await deps.deals.get(b.dealId);
    return mesaDealView(d);
  });
  // Público: a página /convite resolve o contexto do convite (sem login do PM).
  app.get('/v1/portal/mesa/invites/:token', async req => { const { token } = req.params as { token: string }; const r = deps.portal.resolveInvite(token); if (!r) throw new DomainError('INVALID_INPUT', 'Convite inválido ou expirado'); return r; });
  // Confirmação do dono: prova = sessão de carteira (challenge/verify). Em dev, aceita corpo sem assinatura.
  app.post('/v1/portal/mesa/invites/:token/confirm', async (req, reply) => {
    const { token } = req.params as { token: string };
    // Endereços multichain (verum.getAddresses()) vêm no corpo em qualquer caminho.
    const extra = parse(z.object({ addresses: WalletAddressesZ }), req.body ?? {});
    let wallet: { address: string; network: string; addresses?: { network: string; address: string }[] };
    if (req.session) { wallet = { address: req.session.address, network: req.session.network }; }
    else if (deps.env === 'dev') { wallet = parse(z.object({ address: z.string().min(8).max(120), network: z.string().min(2).max(40) }), req.body); }
    else { throw new DomainError('FORBIDDEN', 'Prove a posse da carteira (assine o desafio) antes de confirmar'); }
    wallet.addresses = extra.addresses;
    const inv = deps.portal.confirmInvite(token, wallet);
    await deps.audit.append({ actorType: 'user', actorId: 'portal', category: 'portal.invite.confirm', dealId: null, payload: { role: inv.role, address: wallet.address } });
    void reply.code(201); return inv;
  });
  // PM autenticado revoga um convite.
  app.post('/v1/portal/mesa/invites/revoke', async req => { const b = parse(z.object({ role: MesaRoleZ.optional(), inviteToken: z.string().max(200).optional() }), req.body); deps.portal.revokeInvite(portalToken(req), b); return { ok: true }; });

  /* ---------- Mesas multi-instância (v3): cadeiras + convites por cadeira + prova de posse ---------- */
  const ChairRoleZ = z.enum(['SELLER', 'BUYER', 'PAYMASTER_1', 'PAYMASTER_2']);
  const AuthNetZ = z.enum(['ethereum', 'solana', 'tron', 'bitcoin']);
  const ChairAssetZ = z.object({ network: z.string().min(2).max(40), contractOrMint: z.string().max(120).nullable().default(null), decimals: z.number().int().min(0).max(30), symbol: z.string().min(1).max(20) });
  const readers = deps.balanceReaders ?? defaultBalanceReaders();
  // Verificação de segurança de tokens: registro oficial + (opcional) API da Verum Wallet.
  // Em dev, os tokens de teste (tUSDT/tBTC Sepolia e mints locais da Solana) são canônicos.
  const devAllowedTokens = deps.dev ? ['USDT1111111111111111111111111111111111111111', 'USDC1111111111111111111111111111111111111111', deps.dev.evm?.tusdt, deps.dev.evm?.tbtc] : [];
  const tokenSecurity = process.env.VERUM_WALLET_SECURITY_URL
    ? composeCheckers(registryChecker({ allowed: devAllowedTokens }), verumWalletChecker(process.env.VERUM_WALLET_SECURITY_URL))
    : registryChecker({ allowed: devAllowedTokens });
  /** Mesa do admin autenticado (lança FORBIDDEN quando não é o dono). */
  const adminMesa = (req: FastifyRequest, mesaId: string, activity = true) => {
    const pm = deps.portal.requirePayMaster(portalToken(req), activity);
    const mesa = deps.mesa.mesaById(mesaId);
    if (!mesa || mesa.payMasterId !== pm.id) throw new DomainError('FORBIDDEN', 'Mesa não encontrada para este Pay Master');
    return { pm, mesa };
  };
  /** Quantidade exigida (unidades humanas) por cadeira — o escrow tem duas pernas: Vendedor e Comprador depositam. */
  const requiredOfChair = (mesa: { config?: { amountInBase?: string; buyerAmountInBase?: string } }) => (chair: MesaChair): number | null => {
    const base = chair.role === 'SELLER' ? mesa.config?.amountInBase : chair.role === 'BUYER' ? mesa.config?.buyerAmountInBase : undefined;
    if (!base) return null;
    return Number(BigInt(base)) / 10 ** chair.expectedAsset.decimals;
  };
  /** Mesa 100% demo (carteiras do keyring) → saldos canned, sem RPC. */
  const isDemoMesa = (mesa: { chairs: MesaChair[] }): boolean => {
    const demo = deps.dev?.demo; if (!demo) return false;
    const connected = mesa.chairs.filter(c => c.wallet);
    return connected.length > 0 && connected.every(c => demo.addresses.has(c.wallet!.address));
  };
  const mesaBalances = async (mesa: Parameters<typeof requiredOfChair>[0] & { chairs: MesaChair[] }) => {
    if (isDemoMesa(mesa)) return { ok: true as const, checkedAt: deps.mesa.nowMs(), chairs: [], failures: [] as string[], demo: true };
    return validateChairBalances(mesa as Parameters<typeof validateChairBalances>[0], readers, deps.mesa.nowMs(), requiredOfChair(mesa));
  };
  /**
   * balancePreCheck — gate ÚNICO antes de sacramentar a operação: todos na mesa veem os saldos das
   * duas pernas (ex.: BTC do Vendedor e USDT do Comprador) lidos ON-CHAIN nas redes de cada lado, e
   * nenhuma assinatura do termsHash passa sem `ok`. Também informa a trava de irrevogabilidade:
   * leg de contrato financiada → `canCancel: false` (o fluxo segue até a preimage ou o timelock).
   */
  const balancePreCheck = async (mesa: MesaRecord) => {
    const report = await mesaBalances(mesa);
    const irreversible = await deps.mesa.irreversibleOf(mesa);
    return { ...report, irreversible, canCancel: !mesa.cancelled && !irreversible };
  };

  // Relógio do servidor — autoridade única dos timers do frontend.
  app.get('/v1/time', async () => ({ time: deps.mesa.nowMs() }));

  // Tokens autorizados por rede (espelho do registro oficial sincronizado de verum-otc-onchain).
  // Alimenta o dropdown do wizard: o usuário escolhe o token; contrato/mint e decimais vêm daqui.
  const TOKEN_CHAIN_BY_NETWORK: Record<string, number> = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, solana: 101, tron: 728126428 };
  app.get('/v1/tokens', async req => {
    const { network } = req.query as { network?: string };
    const chainId = network ? TOKEN_CHAIN_BY_NETWORK[network] : undefined;
    const tokens = registryData.tokens
      .filter(t => t.status === 'ACTIVE' && (chainId === undefined || t.chainId === chainId))
      .map(t => ({ symbol: t.symbol, contractOrMint: t.address, decimals: t.decimals, representationOf: ('representationOf' in t ? (t as { representationOf?: string }).representationOf : undefined) ?? null }));
    // Em dev (Sepolia) os tokens reais de teste do escrow entram na lista para o wizard funcionar de ponta a ponta.
    if (deps.dev?.evm && (!network || network === 'ethereum')) {
      tokens.unshift(
        { symbol: 'tUSDT', contractOrMint: deps.dev.evm.tusdt, decimals: 6, representationOf: 'USDT (teste Sepolia)' },
        { symbol: 'tBTC', contractOrMint: deps.dev.evm.tbtc, decimals: 8, representationOf: 'BTC (teste Sepolia)' },
      );
    }
    return { network: network ?? null, tokens };
  });

  // --- admin (sessão do portal) ---
  app.post('/v1/portal/mesas', async (req, reply) => {
    // v4: `network` é opcional — derivada da cadeira do vendedor quando ausente (redes são por perna).
    const b = parse(z.object({ label: z.string().max(120).optional(), network: z.string().min(2).max(40).optional(), chairs: z.array(z.object({ role: ChairRoleZ, expectedAsset: ChairAssetZ, label: z.string().max(120).optional() })).min(2).max(4) }), req.body);
    const mesa = deps.mesa.createMesa(portalToken(req), b);
    void reply.code(201);
    return deps.mesa.mesaViewFor(mesa, { kind: 'admin' });
  });
  app.get('/v1/portal/mesas', async req => ({ mesas: await deps.mesa.listMesas(portalToken(req)) }));
  app.get('/v1/portal/mesas/:mesaId', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const { mesa } = adminMesa(req, mesaId, false);
    return deps.mesa.mesaViewFor(mesa, { kind: 'admin' });
  });
  app.post('/v1/portal/mesas/:mesaId/chairs/:chairId/invite', async (req, reply) => {
    const { mesaId, chairId } = req.params as { mesaId: string; chairId: string };
    // Link do convite com o host REAL desta requisição (deploy Vercel, domínio próprio ou local)
    // — o APP_DOMAIN configurado é só fallback (o default apontava para domínio inexistente).
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0];
    const baseUrl = req.headers.host ? `${proto}://${req.headers.host}` : undefined;
    const inv = await deps.mesa.createChairInvite(portalToken(req), mesaId, chairId, baseUrl);
    void reply.code(201); return inv;
  });
  app.post('/v1/portal/mesas/:mesaId/invites/:inviteId/revoke', async (req) => {
    const { mesaId, inviteId } = req.params as { mesaId: string; inviteId: string };
    await deps.mesa.revokeInvite(portalToken(req), mesaId, inviteId);
    return { ok: true };
  });
  app.post('/v1/portal/mesas/:mesaId/chairs/:chairId/revoke', async (req) => {
    const { mesaId, chairId } = req.params as { mesaId: string; chairId: string };
    await deps.mesa.revokeChair(portalToken(req), mesaId, chairId);
    return { ok: true };
  });
  app.patch('/v1/portal/mesas/:mesaId/config', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const b = parse(z.object({ amountInBase: z.string().regex(/^[1-9][0-9]*$/).optional(), buyerAmountInBase: z.string().regex(/^[1-9][0-9]*$/).optional(), discountBps: z.number().int().min(0).max(2000).optional(), commissionBps: z.number().int().min(0).max(5000).optional(), commissionPayer: z.enum(['SELLER', 'BUYER', 'SPLIT']).optional(), notes: z.string().max(500).optional() }), req.body ?? {});
    return deps.mesa.updateConfig(portalToken(req), mesaId, b);
  });
  app.get('/v1/portal/mesas/:mesaId/balances', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const { mesa } = adminMesa(req, mesaId, false);
    const report = await mesaBalances(mesa);
    await deps.audit.append({ actorType: 'user', actorId: mesa.payMasterId, category: 'mesa.saldos.revalidados', dealId: null, payload: { mesaId, ok: report.ok, failures: report.failures } });
    return report;
  });
  // balancePreCheck do admin: saldos das duas pernas + trava de irrevogabilidade (canCancel).
  app.get('/v1/portal/mesas/:mesaId/precheck', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const { mesa } = adminMesa(req, mesaId, false);
    return balancePreCheck(mesa);
  });
  /**
   * APROVAR OPERAÇÃO (admin-only): só habilita com cadeiras conectadas + posse confirmada +
   * saldos/gás revalidados on-chain + mesa no prazo. Qualquer falha → 409 com motivos NOMINAIS.
   * Ao aprovar: termos congelados (termsHash) e Deal criada pelo serviço existente (quando dev).
   */
  app.post('/v1/portal/mesas/:mesaId/approve', async (req, reply) => {
    const { mesaId } = req.params as { mesaId: string };
    const token = portalToken(req);
    const { pm, mesa } = adminMesa(req, mesaId);
    const b = parse(MesaDealBodyZ, req.body ?? {});
    deps.portal.require2FA(token, b.twoFactorCode);
    if (mesa.cancelled) throw new DomainError('VERSION_CONFLICT', 'Mesa cancelada.');
    if (deps.mesa.nowMs() >= mesa.expiresAt) throw new DomainError('VERSION_CONFLICT', 'Mesa expirada — crie uma nova mesa.');
    if (mesa.approvedAt) throw new DomainError('VERSION_CONFLICT', 'Operação já aprovada.');
    // Anti-scam: token que se passa por USDT/USDC/WBTC… com contrato divergente do registro oficial
    // (ou marcado como malicioso pela Verum Wallet) BLOQUEIA a operação com 403 — antes de qualquer saldo.
    const scam = await validateMesaTokens(mesa.chairs, tokenSecurity);
    if (scam.length) {
      await deps.audit.append({ actorType: 'user', actorId: pm.id, category: 'mesa.aprovacao.token_scam', dealId: null, payload: { mesaId, motivos: scam } });
      throw new DomainError('FORBIDDEN', 'Operação travada: token reprovado na verificação de segurança', { motivos: scam });
    }
    const motivos: string[] = [];
    for (const c of mesa.chairs) if (!c.wallet) motivos.push(`${c.role === 'SELLER' ? 'Vendedor' : c.role === 'BUYER' ? 'Comprador' : c.role === 'PAYMASTER_2' ? 'Pay Master 2' : 'Pay Master 1'}: carteira não conectada`);
    if (!mesa.config?.amountInBase) motivos.push('Configuração: quantidade da operação não definida');
    if (!motivos.length) {
      const report = await mesaBalances(mesa);
      motivos.push(...report.failures);
    }
    if (motivos.length) {
      await deps.audit.append({ actorType: 'user', actorId: pm.id, category: 'mesa.aprovacao.bloqueada', dealId: null, payload: { mesaId, motivos } });
      throw new DomainError('VERSION_CONFLICT', 'Não foi possível aprovar a operação', { motivos });
    }
    deps.mesa.markApproved(mesa, pm.id);
    const body = { ...b, amountInBase: mesa.config?.amountInBase ?? b.amountInBase, discountBps: mesa.config?.discountBps ?? b.discountBps, commissionBps: mesa.config?.commissionBps ?? b.commissionBps };
    // Plano HTLC_BTC → deal REAL com os ativos das CADEIRAS (BTC nativo ↔ token no escrow V2).
    // Demais planos seguem o caminho legado (base dev) até o wiring ESCROW_DIRECT/CROSS_CHAIN.
    const plan = deriveSettlementPlan(mesa.chairs);
    const view = plan?.mode === 'HTLC_BTC'
      ? await createMesaHtlcDeal(mesa, body, id => deps.mesa.attachDeal(mesa, id))
      : await createMesaDealForParts(mesa.chairs.filter(c => c.wallet).map(c => {
        const w = c.wallet!;
        const sol = (w.addresses ?? []).find(a => a.network === 'solana')?.address ?? (w.network === 'solana' ? w.address : null);
        return { role: c.role as Role, address: sol ?? w.address };
      }), body, id => deps.mesa.attachDeal(mesa, id));
    void reply.code(201);
    return { approved: true, termsHash: mesa.termsHash, deal: view };
  });
  app.post('/v1/portal/mesas/:mesaId/deal/sign', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const token = portalToken(req);
    const b = parse(z.object({ twoFactorCode: z.string().max(12).optional() }), req.body ?? {});
    deps.portal.require2FA(token, b.twoFactorCode);
    const { pm, mesa } = adminMesa(req, mesaId);
    if (!mesa.dealId) throw new DomainError('INVALID_INPUT', 'Nenhuma operação ativa nesta mesa');
    // balancePreCheck ON-CHAIN imediatamente antes da assinatura do termsHash — nunca cache/frontend.
    const report = await balancePreCheck(mesa);
    await deps.audit.append({ actorType: 'user', actorId: pm.id, category: 'mesa.saldos.revalidados', dealId: mesa.dealId, payload: { mesaId, ok: report.ok, failures: report.failures } });
    if (!report.ok) throw new DomainError('VERSION_CONFLICT', 'Assinatura bloqueada: saldos insuficientes', { motivos: report.failures });
    return signTurnOfDeal(mesa.dealId);
  });
  /**
   * CARTEIRA REAL do admin (PM1): quando o keyring dev não tem a chave do admin, a assinatura do
   * turno acontece pela PRÓPRIA wallet — GET step (typedData Approval on-chain), POST step
   * (relay do signV2 pelo keeper), GET envelope (DealApproval da mesa) e POST approval (registro).
   */
  const mesaDealOf = async (req: FastifyRequest, mesaId: string) => {
    const { mesa } = adminMesa(req, mesaId, false);
    if (!mesa.dealId) throw new DomainError('INVALID_INPUT', 'Nenhuma operação ativa nesta mesa');
    const d = await deps.deals.get(mesa.dealId);
    const pm1 = d.participants.find(p => p.role === 'PAYMASTER_1');
    if (!pm1) throw new DomainError('NOT_PARTICIPANT', 'operação sem Pay Master 1');
    return { mesa, d, pm1 };
  };
  app.get('/v1/portal/mesas/:mesaId/deal/step', async req => {
    const { d, pm1 } = await mesaDealOf(req, (req.params as { mesaId: string }).mesaId);
    return stepAdapterOf(d).buildParticipantStep(d.id, 'PAYMASTER_1', pm1.address);
  });
  app.post('/v1/portal/mesas/:mesaId/deal/step', async req => {
    const b = parse(z.object({ signature: z.string().min(20), deadline: z.number().int() }), req.body);
    const { d, pm1 } = await mesaDealOf(req, (req.params as { mesaId: string }).mesaId);
    return stepAdapterOf(d).submitParticipantStep(d.id, 'PAYMASTER_1', pm1.address, b as Record<string, unknown>);
  });
  app.get('/v1/portal/mesas/:mesaId/deal/envelope', async req => {
    const { d, pm1 } = await mesaDealOf(req, (req.params as { mesaId: string }).mesaId);
    const env = await deps.deals.envelope(d.id, 'PAYMASTER_1', pm1.address);
    return { scheme: env.scheme, network: env.network, payload: env.payload, message: env.message, typedData: env.typedData ? { ...env.typedData, message: Object.fromEntries(Object.entries(env.typedData.message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) } : undefined };
  });
  app.post('/v1/portal/mesas/:mesaId/deal/approval', async req => {
    const b = parse(z.object({ signature: z.string().min(20), nonce: z.string().min(8) }), req.body);
    const { d, pm1 } = await mesaDealOf(req, (req.params as { mesaId: string }).mesaId);
    // Autoridade: sessão do portal (dono da mesa) + a assinatura é criptograficamente do pm1.address.
    const r = await deps.deals.submitSignature(d.id, { role: 'PAYMASTER_1', signer: pm1.address, scheme: 'secp256k1', signature: b.signature, nonce: b.nonce }, pm1.address);
    return { count: r.count, required: r.deal.requiredSignatures, state: r.deal.state };
  });
  app.post('/v1/portal/mesas/:mesaId/cancel', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const b = parse(z.object({ reason: z.string().max(200).default('') }), req.body ?? {});
    await deps.mesa.cancelMesa(portalToken(req), mesaId, b.reason);
    return { ok: true };
  });

  // --- público (página do convite) ---
  app.get('/v1/mesa-invites/:inviteId', async req => {
    const { inviteId } = req.params as { inviteId: string };
    const q = parse(z.object({ c: z.string().max(20).optional() }), req.query ?? {});
    return deps.mesa.resolveInvite(inviteId, q.c);
  });
  // Validação com LOG (warn): os campos reprovados aparecem no runtime log — era impossível
  // diagnosticar o "Entrada inválida" do convite sem acesso ao f12 do usuário.
  const parseInvite = <T>(route: string, schema: z.ZodType<T>, v: unknown): T => {
    try { return parse(schema, v); }
    catch (e) {
      const issues = (e as DomainError).details?.issues as { path?: (string | number)[]; code?: string; message?: string }[] | undefined;
      logger.warn({ route, issues: issues?.map(i => ({ path: (i.path ?? []).join('.'), code: i.code, message: i.message })) }, 'convite: entrada inválida');
      throw e;
    }
  };
  app.post('/v1/mesa-invites/:inviteId/challenge', async (req, reply) => {
    const { inviteId } = req.params as { inviteId: string };
    const b = parseInvite('mesa-invites/challenge', z.object({ code: z.string().min(4).max(20), firstName: z.string().min(1).max(60), network: AuthNetZ, address: z.string().min(8).max(120) }), req.body);
    const r = await deps.mesa.joinChallenge(inviteId, { ...b, network: b.network as AuthNetwork });
    void reply.code(201); return r;
  });
  app.post('/v1/mesa-invites/:inviteId/join', async (req, reply) => {
    const { inviteId } = req.params as { inviteId: string };
    const b = parseInvite('mesa-invites/join', z.object({ code: z.string().min(4).max(20), firstName: z.string().min(1).max(60), network: AuthNetZ, address: z.string().min(8).max(120), nonce: z.string().min(8).max(80), signature: z.string().min(20).max(400), addresses: WalletAddressesZ }), req.body);
    const r = await deps.mesa.joinMesa(inviteId, { ...b, network: b.network as AuthNetwork });
    void reply.code(201); return r;
  });
  // REENTRADA (somente leitura) de uma carteira já vinculada — sem novo convite. Prova de posse
  // por assinatura; devolve um token de participante novo (o antigo expira em 24h).
  app.post('/v1/mesas/:mesaId/reenter/challenge', async (req, reply) => {
    const { mesaId } = req.params as { mesaId: string };
    const b = parse(z.object({ network: AuthNetZ, address: z.string().min(8).max(120) }), req.body);
    const r = await deps.mesa.reenterChallenge(mesaId, { ...b, network: b.network as AuthNetwork });
    void reply.code(201); return r;
  });
  app.post('/v1/mesas/:mesaId/reenter', async (req, reply) => {
    const { mesaId } = req.params as { mesaId: string };
    const b = parse(z.object({ network: AuthNetZ, address: z.string().min(8).max(120), nonce: z.string().min(8).max(80), signature: z.string().min(20).max(400) }), req.body);
    const r = await deps.mesa.reenterMesa(mesaId, { ...b, network: b.network as AuthNetwork });
    void reply.code(201); return r;
  });
  // Conexão SEM assinatura de mensagem (a posse é provada pela conexão da Verum Wallet, como o
  // admin) — o signMessage do provider nativo da Verum não entrega a assinatura no dapp-browser.
  app.post('/v1/mesa-invites/:inviteId/connect', async (req, reply) => {
    const { inviteId } = req.params as { inviteId: string };
    const b = parseInvite('mesa-invites/connect', z.object({ code: z.string().min(4).max(20), firstName: z.string().min(1).max(60), network: AuthNetZ, address: z.string().min(8).max(120), addresses: WalletAddressesZ }), req.body);
    const r = await deps.mesa.connectMesa(inviteId, { ...b, network: b.network as AuthNetwork });
    void reply.code(201); return r;
  });

  // --- mesa (admin OU participante; DTO recortado por papel NO BACKEND) ---
  app.get('/v1/mesas/:mesaId', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const mesaClaim = req.session?.mesa;
    if (mesaClaim && mesaClaim.mesaId === mesaId) {
      const mesa = deps.mesa.mesaById(mesaId);
      if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada');
      return deps.mesa.mesaViewFor(mesa, { kind: 'participant', chairId: mesaClaim.chairId });
    }
    const { mesa } = adminMesa(req, mesaId, false);
    return deps.mesa.mesaViewFor(mesa, { kind: 'admin' });
  });
  // Saldos para exibição a todos os participantes (indicadores suficiente/insuficiente).
  app.get('/v1/mesas/:mesaId/balances', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const mesaClaim = req.session?.mesa;
    if (mesaClaim && mesaClaim.mesaId === mesaId) {
      const mesa = deps.mesa.mesaById(mesaId);
      if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada');
      return mesaBalances(mesa);
    }
    const { mesa } = adminMesa(req, mesaId, false);
    return mesaBalances(mesa);
  });
  // balancePreCheck para TODOS na mesa: saldos das duas pernas + trava de irrevogabilidade.
  app.get('/v1/mesas/:mesaId/precheck', async req => {
    const { mesaId } = req.params as { mesaId: string };
    const mesaClaim = req.session?.mesa;
    if (mesaClaim && mesaClaim.mesaId === mesaId) {
      const mesa = deps.mesa.mesaById(mesaId);
      if (!mesa) throw new DomainError('INVALID_INPUT', 'Mesa não encontrada');
      return balancePreCheck(mesa);
    }
    const { mesa } = adminMesa(req, mesaId, false);
    return balancePreCheck(mesa);
  });
  // Participante tenta editar a configuração → 403 (a edição é exclusiva do admin).
  app.patch('/v1/mesas/:mesaId/config', async req => {
    if (req.session?.mesa) throw new DomainError('FORBIDDEN', 'Somente o Pay Master 1 edita a configuração da mesa');
    const { mesaId } = req.params as { mesaId: string };
    const b = parse(z.object({ amountInBase: z.string().regex(/^[1-9][0-9]*$/).optional(), discountBps: z.number().int().min(0).max(2000).optional(), commissionBps: z.number().int().min(0).max(5000).optional() }), req.body ?? {});
    return deps.mesa.updateConfig(portalToken(req), mesaId, b);
  });

  /* ---------- UI (HTML autocontido) ---------- */
  // HTML autocontido servido sem cache: garante que toda alteração de UI apareça no próximo reload (sem hard-refresh manual).
  const sendHtml = (reply: FastifyReply, html: string): FastifyReply => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store, must-revalidate').send(html);
  // As páginas recebem as tags PWA (manifest/ícones), o registro do SW e o provider da Verum
  // (window.verum p/ quando o OTC roda DENTRO do navegador dApp da Verum — via iframe/postMessage).
  const dirOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '');
  const withApiMeta = (path: string): string => readFileSync(path, 'utf8').replace('<meta name="verum-otc-api" content="">', `<meta name="verum-otc-api" content="/">`);
  const withProvider = (html: string): string => html.replace('</head>', '<script src="/verum-provider.js"></script></head>');
  const prepHtml = (path: string): string => withProvider(injectPwa(withApiMeta(path)));
  // Convite: SEM service worker (injectPwaNoSW desregistra SW antigo + limpa caches) — um SW preso
  // estava servindo o HTML velho do convite no dapp-browser da Verum.
  const prepHtmlNoSW = (path: string): string => withProvider(injectPwaNoSW(withApiMeta(path)));
  if (deps.mesaHtmlPath) { const mesa = prepHtml(deps.mesaHtmlPath); for (const p of ['/mesa', '/operacao', '/operacoes', '/abrir-mesa']) app.get(p, async (_req, reply) => sendHtml(reply, mesa)); }
  if (deps.portalHtmlPath) { const portalHtml = prepHtml(deps.portalHtmlPath); for (const p of ['/portal', '/cadastro', '/login']) app.get(p, async (_req, reply) => sendHtml(reply, portalHtml)); }
  if (deps.conviteHtmlPath) { const convite = prepHtmlNoSW(deps.conviteHtmlPath); for (const p of ['/convite', '/convite/:token', '/invite', '/invite/:token', '/otc/convite/:token']) app.get(p, async (_req, reply) => sendHtml(reply, convite)); }
  // Provider da Verum (window.verum) — só ativa quando embutido no iframe do navegador dApp da Verum.
  // Same-origin (CSP script-src 'self'). Lido do mesmo diretório dos HTML.
  const webDir = deps.mesaHtmlPath ? dirOf(deps.mesaHtmlPath) : deps.portalHtmlPath ? dirOf(deps.portalHtmlPath) : deps.conviteHtmlPath ? dirOf(deps.conviteHtmlPath) : null;
  if (webDir) { let providerJs = ''; try { providerJs = readFileSync(`${webDir}/verum-provider.js`, 'utf8'); } catch { /* ausente */ } app.get('/verum-provider.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'public, max-age=3600').send(providerJs)); }
  // A raiz encaminha para a entrada do portal (login/cadastro exigido antes da mesa).
  app.get('/', async (_req, reply) => reply.redirect('/portal'));

  /* ---------- PWA (manifest, service worker, ícones, offline) — same-origin, sem dados sensíveis em cache ---------- */
  app.get('/manifest.webmanifest', async (_req, reply) => reply.type('application/manifest+json').header('cache-control', 'public, max-age=3600').send(MANIFEST_JSON));
  app.get('/sw.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').header('service-worker-allowed', '/').send(SW_JS));
  app.get('/offline.html', async (_req, reply) => sendHtml(reply, OFFLINE_HTML));
  app.get('/icons/verum.svg', async (_req, reply) => reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(ICON_SVG));
  app.get('/icons/verum-maskable.svg', async (_req, reply) => reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(ICON_MASKABLE_SVG));

  app.get('/v1/networks', async () => (['bitcoin', 'ethereum', 'solana'] as Network[]));

  /* ---------- Multichain: 18 redes lidas pela Verum Wallet ---------- */
  // Metadados das 18 redes + ícone REAL da moeda (servido pelo proxy same-origin). Público.
  app.get('/v1/chains', async () => { const icons = await getIconMap().catch(() => ({} as Record<string, string>)); return { chains: allChains().map(c => { const iid = chainIconId(c); return { ...c, icon: iid && icons[iid] ? '/v1/chains/icon/' + iid : null }; }) }; });
  // Proxy dos logos: busca no upstream (CoinGecko) e serve pela própria OTC, para
  // passar no CSP img-src 'self'. Cacheado em memória + Cache-Control no browser.
  app.get('/v1/chains/icon/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const now = Date.now();
    const cached = iconBufCache.get(id);
    if (cached && now - cached.at < ICON_BUF_TTL) { void reply.header('content-type', cached.ct); void reply.header('cache-control', 'public, max-age=86400'); return reply.send(cached.buf); }
    const icons = await getIconMap().catch(() => ({} as Record<string, string>));
    const url = icons[id];
    if (!url) { void reply.code(404); return reply.send('not found'); }
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(timer);
      if (!r.ok) { void reply.code(502); return reply.send('upstream'); }
      const ct = r.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await r.arrayBuffer());
      iconBufCache.set(id, { at: now, ct, buf });
      void reply.header('content-type', ct); void reply.header('cache-control', 'public, max-age=86400');
      return reply.send(buf);
    } catch { void reply.code(502); return reply.send('error'); }
  });
  // Preços dos ativos nativos via API pública de mercado (cache 60s). Público.
  // Fora de produção, redes sem cotação (CoinGecko fora/limitado) caem na tabela estática
  // da demo — a apresentação nunca fica com preços vazios.
  app.get('/v1/chains/prices', async () => {
    const prices = await getPrices();
    if (deps.dev?.demo) {
      const { DEMO_PRICES_USD, DEMO_BRL_RATE } = await import('../portal/demo.js');
      for (const [k, v] of Object.entries(prices)) if (v.usd == null && DEMO_PRICES_USD[k] != null) prices[k] = { usd: DEMO_PRICES_USD[k], brl: DEMO_PRICES_USD[k] * DEMO_BRL_RATE };
    }
    return { prices };
  });
  // Redes que têm USDT/USDC + ícones reais dos stablecoins. Público.
  app.get('/v1/chains/stablecoins', async () => { const icons = await getIconMap().catch(() => ({} as Record<string, string>)); return { networks: stablecoinNetworks(), icons: { USDT: icons['tether'] ? '/v1/chains/icon/tether' : null, USDC: icons['usd-coin'] ? '/v1/chains/icon/usd-coin' : null } }; });
  // Saldo NATIVO por endereço em cada rede + valor em USD/BRL. Leitura pura;
  // a OTC lê aqui (backend) para evitar CORS e centralizar. Recebe os endereços
  // que a carteira já expôs via verum.getAddresses().
  app.post('/v1/chains/balances', async req => {
    const body = parse(z.object({
      addresses: z.array(z.object({
        network: z.string().min(2).max(40),
        address: z.string().min(8).max(120),
      })).min(1).max(30),
    }), req.body);

    // Carteiras da mesa DEMO → saldos canned (nunca toca RPC nem CoinGecko).
    const demo = deps.dev?.demo;
    if (demo && body.addresses.some(a => demo.addresses.has(a.address))) {
      const { demoBalancesResponse } = await import('../portal/demo.js');
      return demoBalancesResponse(demo.keyring, body.addresses);
    }

    const [byId, icons] = await Promise.all([
      getPricesById().catch(() => ({} as Awaited<ReturnType<typeof getPricesById>>)),
      getIconMap().catch(() => ({} as Record<string, string>)),
    ]);
    const q = (id: string) => byId[id] ?? { usd: null, brl: null };

    const items = await Promise.all(body.addresses.map(async ({ network, address }) => {
      const chain = getChain(network);
      if (!chain) return { network, address, supported: false as const };
      // Nativo + tokens em paralelo — a falha de um nunca derruba o outro.
      const [bal, toks] = await Promise.all([
        readNativeBalance(network, address).catch(() => null),
        readTokenBalances(network, address).catch(() => []),
      ]);
      const price = q(chain.coingeckoId);
      const amount = bal?.amount ?? null;
      const tokens = toks.map(t => {
        const tp = t.coingeckoId ? q(t.coingeckoId) : { usd: null, brl: null };
        return {
          symbol: t.symbol, contract: t.contract, decimals: t.decimals, amount: t.amount,
          icon: t.coingeckoId && icons[t.coingeckoId] ? '/v1/chains/icon/' + t.coingeckoId : null,
          priceUsd: tp.usd, priceBrl: tp.brl,
          valueUsd: tp.usd != null ? t.amount * tp.usd : null,
          valueBrl: tp.brl != null ? t.amount * tp.brl : null,
        };
      });
      return {
        network: chain.chainKey,
        displayName: chain.displayName,
        address,
        supported: true as const,
        symbol: chain.nativeSymbol,
        decimals: chain.nativeDecimals,
        explorer: chain.explorer,
        icon: icons[chain.coingeckoId] ? '/v1/chains/icon/' + chain.coingeckoId : null,
        ok: bal !== null,
        amount,
        raw: bal?.raw ?? null,
        priceUsd: price.usd,
        priceBrl: price.brl,
        valueUsd: amount != null && price.usd != null ? amount * price.usd : null,
        valueBrl: amount != null && price.brl != null ? amount * price.brl : null,
        tokens,
      };
    }));

    // Totais somam nativo + tokens de todos os endereços.
    let totalUsd = 0, totalBrl = 0;
    for (const i of items) {
      if (!('supported' in i) || i.supported === false) continue;
      totalUsd += i.valueUsd || 0; totalBrl += i.valueBrl || 0;
      for (const t of i.tokens) { totalUsd += t.valueUsd || 0; totalBrl += t.valueBrl || 0; }
    }
    return { items, totalUsd, totalBrl };
  });

  return app;
}
