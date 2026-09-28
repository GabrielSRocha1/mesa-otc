/**
 * Armazenamento do módulo de identidade. Interface + implementação em memória (dev/testes),
 * com o mesmo contrato que um repositório Postgres cumpriria. Unicidade de carteira, e-mail
 * (por índice cego) e telefone (por índice cego) é garantida aqui.
 */
import { DomainError } from '../domain/errors.js';
import type { AccountRow } from './types.js';

export interface IdentityStore {
  insert(row: AccountRow): void;
  get(id: string): AccountRow | undefined;
  getByWallet(walletCaip10: string): AccountRow | undefined;
  findByEmailIndex(index: string): AccountRow | undefined;
  findByPhoneIndex(index: string): AccountRow | undefined;
  update(id: string, patch: Partial<AccountRow>): AccountRow;
  all(): AccountRow[];
}

/** Store em memória. Índices auxiliares mantêm unicidade e busca O(1). */
export class InMemoryIdentityStore implements IdentityStore {
  private rows = new Map<string, AccountRow>();
  private byWallet = new Map<string, string>();
  private byEmail = new Map<string, string>();
  private byPhone = new Map<string, string>();

  insert(row: AccountRow): void {
    if (this.byWallet.has(row.walletCaip10)) throw new DomainError('VERSION_CONFLICT', 'Carteira já vinculada a uma conta');
    this.rows.set(row.id, { ...row });
    this.byWallet.set(row.walletCaip10, row.id);
    if (row.emailIndex) this.byEmail.set(row.emailIndex, row.id);
    if (row.phoneIndex) this.byPhone.set(row.phoneIndex, row.id);
  }
  get(id: string): AccountRow | undefined { const r = this.rows.get(id); return r ? { ...r } : undefined; }
  getByWallet(walletCaip10: string): AccountRow | undefined { const id = this.byWallet.get(walletCaip10); return id ? this.get(id) : undefined; }
  findByEmailIndex(index: string): AccountRow | undefined { const id = this.byEmail.get(index); return id ? this.get(id) : undefined; }
  findByPhoneIndex(index: string): AccountRow | undefined { const id = this.byPhone.get(index); return id ? this.get(id) : undefined; }

  update(id: string, patch: Partial<AccountRow>): AccountRow {
    const cur = this.rows.get(id);
    if (!cur) throw new DomainError('INVALID_INPUT', 'Conta inexistente');
    // Mantém índices de unicidade coerentes ao trocar e-mail/telefone.
    if ('emailIndex' in patch) { if (cur.emailIndex) this.byEmail.delete(cur.emailIndex); if (patch.emailIndex) this.byEmail.set(patch.emailIndex, id); }
    if ('phoneIndex' in patch) { if (cur.phoneIndex) this.byPhone.delete(cur.phoneIndex); if (patch.phoneIndex) this.byPhone.set(patch.phoneIndex, id); }
    const next = { ...cur, ...patch, updatedAt: patch.updatedAt ?? cur.updatedAt };
    this.rows.set(id, next);
    return { ...next };
  }
  all(): AccountRow[] { return [...this.rows.values()].map(r => ({ ...r })); }
}
