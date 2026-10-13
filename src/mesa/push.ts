/**
 * Web Push "é sua vez de assinar" — notificação que puxa o participante de volta à mesa quando
 * chega a vez dele. Degradação graciosa: sem VAPID configurado, fica DESLIGADO (enabled=false) e
 * todas as chamadas são no-op — nunca quebra o fluxo. O envio nunca lança para o chamador.
 */
import webpush from 'web-push';

export interface VapidConfig { publicKey: string; privateKey: string; subject: string }

export interface PushPayload { title: string; body: string; url: string; tag?: string }

export class PushService {
  readonly enabled: boolean;
  readonly publicKey: string;
  constructor(cfg: VapidConfig | null, private readonly log?: { warn: (o: unknown, m: string) => void }) {
    this.enabled = !!cfg;
    this.publicKey = cfg?.publicKey ?? '';
    if (cfg) {
      try { webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey); }
      catch (e) { this.enabled = false; this.log?.warn({ err: (e as Error).message }, 'push: VAPID inválido — desligado'); }
    }
  }
  /** Envia para UMA inscrição. Nunca lança. Retorna true se entregue ao serviço de push. */
  async send(subscription: unknown, payload: PushPayload): Promise<boolean> {
    if (!this.enabled || !subscription) return false;
    try {
      await webpush.sendNotification(subscription as webpush.PushSubscription, JSON.stringify(payload));
      return true;
    } catch (e) {
      // 404/410 = inscrição morta; demais = transitório. Nunca propaga.
      this.log?.warn({ err: (e as Error).message }, 'push: envio falhou (inscrição morta/transitório)');
      return false;
    }
  }
}

/** Monta a config VAPID a partir das envs; null se incompleta (push desligado). */
export function vapidFrom(c: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT: string }): VapidConfig | null {
  if (!c.VAPID_PUBLIC_KEY || !c.VAPID_PRIVATE_KEY) return null;
  return { publicKey: c.VAPID_PUBLIC_KEY, privateKey: c.VAPID_PRIVATE_KEY, subject: c.VAPID_SUBJECT };
}
