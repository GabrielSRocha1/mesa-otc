/**
 * LightningSimulator — nó LN in-process para preview/dev/teste (LND_SIMULATE=1 ou grupo LND_* ausente).
 *
 * Mantém invoices e pagamentos em memória; o "pagamento" casa `sha256(preimage) == paymentHash` — a
 * MESMA verificação que o contrato faz no settleV2 — e revela a preimage. A liquidez outbound é
 * configurável (default generosa) para exercitar o precheck. Nenhum BTC real se move.
 *
 * Em teste, a preimage do Comprador é registrada via `seedPreimage` (o simulador não a inventa — ela
 * é do Comprador, como na rede real); se nenhuma for semeada, o pagamento falha com 'no_preimage',
 * espelhando uma invoice que o recebedor nunca liquida.
 */
import { sha256Hex } from '../../domain/types.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { LightningService, LnInvoice, LnPayment, LnNodeInfo, LnBalance } from './types.js';

export class LightningSimulator implements LightningService {
  private readonly invoices = new Map<string, LnInvoice>();       // paymentHash → invoice
  private readonly preimages = new Map<string, string>();         // paymentHash → preimage (do Comprador)
  private readonly payments = new Map<string, LnPayment>();       // paymentHash → payment
  private readonly now: () => number;
  constructor(private outboundSat = 100_000_000n, now: () => number = () => Date.now()) { this.now = now; }

  /** TESTE/dev: registra a preimage que o "Comprador" revela ao receber (payment_hash derivado dela). */
  seedPreimage(preimageHex: string): string { const h = sha256Hex(hexToBytes(preimageHex)); this.preimages.set(h, preimageHex.toLowerCase()); return h; }
  setOutbound(sat: bigint): void { this.outboundSat = sat; }

  async getNodeInfo(): Promise<LnNodeInfo> { return { pubkey: '02'.padEnd(66, '0'), alias: 'verum-mesa-sim', chains: ['bitcoin'] }; }
  async getBalance(): Promise<LnBalance> { return { outboundSat: this.outboundSat, inboundSat: 0n }; }

  async addInvoice(paymentHash: string, amountSat: bigint, memo: string): Promise<LnInvoice> {
    const inv: LnInvoice = { bolt11: `lnbcrt-sim-${paymentHash.slice(0, 16)}-${amountSat}`, paymentHash: paymentHash.toLowerCase(), amountSat, expiresAt: this.now() + 600_000 };
    this.invoices.set(inv.paymentHash, inv);
    void memo;
    return inv;
  }
  async decodeInvoice(bolt11: string): Promise<LnInvoice> {
    // bolt11 simulado: lnbcrt-sim-<hash16>-<amount>. Reconhece invoices que o próprio simulador emitiu.
    const m = /^lnbcrt-sim-([0-9a-f]{16})-(\d+)$/.exec(bolt11);
    if (m) { const found = [...this.invoices.values()].find(i => i.paymentHash.startsWith(m[1] as string)); if (found) return found; }
    throw new Error('invoice simulada desconhecida (use addInvoice primeiro)');
  }
  async payInvoice(bolt11: string): Promise<LnPayment> {
    const inv = await this.decodeInvoice(bolt11).catch(() => null);
    if (!inv) return { status: 'failed', paymentHash: '', preimage: null, feeSat: 0n, failureReason: 'invoice_unknown' };
    if (inv.amountSat > this.outboundSat) { const p: LnPayment = { status: 'failed', paymentHash: inv.paymentHash, preimage: null, feeSat: 0n, failureReason: 'insufficient_liquidity' }; this.payments.set(inv.paymentHash, p); return p; }
    const preimage = this.preimages.get(inv.paymentHash);
    if (!preimage) { const p: LnPayment = { status: 'failed', paymentHash: inv.paymentHash, preimage: null, feeSat: 0n, failureReason: 'no_preimage' }; this.payments.set(inv.paymentHash, p); return p; }
    // Pagamento "liquida": o recebedor revela a preimage; a liquidez outbound cai pelo valor entregue.
    this.outboundSat -= inv.amountSat;
    const p: LnPayment = { status: 'succeeded', paymentHash: inv.paymentHash, preimage, feeSat: 1n };
    this.payments.set(inv.paymentHash, p);
    return p;
  }
  async lookupPayment(paymentHash: string): Promise<LnPayment> {
    return this.payments.get(paymentHash.toLowerCase()) ?? { status: 'pending', paymentHash: paymentHash.toLowerCase(), preimage: null, feeSat: 0n };
  }
}
