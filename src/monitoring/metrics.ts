/** Monitoring — métricas Prometheus e logger estruturado (pino). Sem dados sensíveis em logs: assinaturas e envelopes são redigidos. */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import pino from 'pino';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const metrics = {
  transitions: new Counter({ name: 'otc_deal_transitions_total', help: 'Transições de estado', labelNames: ['from', 'to'], registers: [registry] }),
  signaturesAccepted: new Counter({ name: 'otc_signatures_accepted_total', help: 'Assinaturas aceitas', registers: [registry] }),
  signaturesRejected: new Counter({ name: 'otc_signatures_rejected_total', help: 'Assinaturas rejeitadas', labelNames: ['reason'], registers: [registry] }),
  settlements: new Counter({ name: 'otc_settlements_total', help: 'Liquidações por resultado', labelNames: ['result'], registers: [registry] }),
  invariantViolations: new Counter({ name: 'otc_invariant_violations_total', help: 'Tentativas de violar invariantes (liquidar sem N/N, expirada, duplicada)', labelNames: ['kind'], registers: [registry] }),
  priceAnomalies: new Counter({ name: 'otc_price_anomalies_total', help: 'Anomalias de preço detectadas', registers: [registry] }),
  priceBreakerOpen: new Gauge({ name: 'otc_price_breaker_open', help: '1 quando o disjuntor de preço está aberto', registers: [registry] }),
  httpRequests: new Counter({ name: 'otc_http_requests_total', help: 'Requisições HTTP por rota e status', labelNames: ['route', 'status'], registers: [registry] }),
  httpSeconds: new Histogram({ name: 'otc_http_request_seconds', help: 'Latência HTTP', labelNames: ['route'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry] }),
  sseConnections: new Gauge({ name: 'otc_sse_connections', help: 'Conexões SSE/WS abertas', registers: [registry] }),
  adapterErrors: new Counter({ name: 'otc_adapter_errors_total', help: 'Erros de adaptador/RPC', labelNames: ['chain', 'op'], registers: [registry] }),
  activeDeals: new Gauge({ name: 'otc_active_deals', help: 'Deals ativas por estado', labelNames: ['state'], registers: [registry] }),
  verificationSeconds: new Histogram({ name: 'otc_verification_seconds', help: 'Duração de verificação (ativo+preço+liquidez+rota)', buckets: [0.1, 0.5, 1, 2, 5, 10], registers: [registry] }),
  settlementSeconds: new Histogram({ name: 'otc_settlement_seconds', help: 'Duração da liquidação', buckets: [1, 5, 15, 60, 300, 1800], registers: [registry] })
};
const redact = ['signature', 'signatures', '*.signature', 'envelope', 'message', 'privateKey', 'seed', 'authorization', 'req.headers.authorization'];
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: { paths: redact, censor: '[redacted]' }, base: { service: 'verum-otc' } });
