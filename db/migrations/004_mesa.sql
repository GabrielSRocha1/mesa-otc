-- 004_mesa.sql — Convites por CADEIRA das mesas multi-instância (v3).
-- O convite é a ÚNICA porta de entrada do participante: o consumo precisa ser atômico entre
-- instâncias serverless (UPDATE ... WHERE status='PENDING' RETURNING) — por isso vive em tabela
-- própria e não no documento JSONB do portal (que sofre race de sobrescrita entre instâncias).
-- O código XXXX-XXXX nunca é armazenado em claro: apenas hash + prefixo pesquisável.
-- Idempotente: pode rodar no SQL editor do Supabase.

CREATE TABLE IF NOT EXISTS mesa_invites (
  invite_id       text PRIMARY KEY,                 -- id opaco CSPRNG (vai no link)
  mesa_id         text NOT NULL,
  chair_id        text NOT NULL,
  code_hash       text NOT NULL,                    -- sha256(inviteId + ':' + inviteCode)
  code_prefix     text NOT NULL,                    -- 4 primeiros chars (fallback de digitação)
  status          text NOT NULL DEFAULT 'PENDING',  -- PENDING | USED | REVOKED (EXPIRED derivado de expires_at)
  used_by_address text,
  used_by_name    text,
  used_at         bigint,
  created_at      bigint NOT NULL,
  expires_at      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS mesa_invites_mesa ON mesa_invites (mesa_id);
-- No máximo UM convite pendente por cadeira (revogar antes de gerar novo).
CREATE UNIQUE INDEX IF NOT EXISTS mesa_invites_chair_pending ON mesa_invites (mesa_id, chair_id) WHERE status = 'PENDING';

-- RLS habilitado SEM policies: nenhum acesso via API pública do Supabase; o backend conecta
-- por conexão Postgres direta (como portal_state).
ALTER TABLE mesa_invites ENABLE ROW LEVEL SECURITY;
