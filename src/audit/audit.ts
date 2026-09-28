/** Audit Log — append-only com encadeamento por hash (RF-090). Verificável offline (RNF-011). */
import { sha256Hex, canonicalize, type AuditEvent } from '../domain/types.js';
import type { Store } from '../db/repository.js';

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly store: Store, private readonly now: () => number = () => Date.now()) {}
  /** Serializa escritas para manter a cadeia consistente sob concorrência no mesmo processo. */
  append(e: { actorType: AuditEvent['actorType']; actorId: string; category: string; dealId: string | null; payload: Record<string, unknown> }): Promise<AuditEvent> {
    let out!: AuditEvent;
    this.chain = this.chain.then(async () => {
      const last = await this.store.lastAudit(); const seq = (last?.seq ?? 0) + 1; const at = this.now(); const prevHash = last?.hash ?? '0'.repeat(64);
      const payloadHash = sha256Hex(canonicalize(e.payload)); const hash = sha256Hex(`${prevHash}|${payloadHash}|${seq}|${at}`);
      out = { seq, at, prevHash, payloadHash, hash, ...e }; await this.store.appendAudit(out);
    });
    return this.chain.then(() => out);
  }
  static verify(events: AuditEvent[]): { ok: boolean; brokenAt: number | null } {
    let prev = '0'.repeat(64);
    for (const e of events) { const ph = sha256Hex(canonicalize(e.payload)); const h = sha256Hex(`${prev}|${ph}|${e.seq}|${e.at}`); if (ph !== e.payloadHash || h !== e.hash || e.prevHash !== prev) return { ok: false, brokenAt: e.seq }; prev = e.hash; }
    return { ok: true, brokenAt: null };
  }
}
