-- 005_indexed_pricing.sql — Operar Indexado: fixing do preço indexado ao Verum Swap (ADITIVO).
-- A indexação é 100% off-chain e termina ANTES das assinaturas: o contrato on-chain NÃO muda e sempre
-- liquida valores FIXOS. Este registro guarda o fixing (preço congelado) 1:1 com a mesa, VERSIONADO
-- junto com os termos (terms_version cresce a cada refixing pós-aprovação). Depois de LOCKED o registro
-- é IMUTÁVEL (trigger). A auditoria de cada fixing/refixing/cancelamento/rejeição vive em audit_events
-- (append-only, hash-encadeada) — como todo o resto do sistema.
-- Idempotente: pode rodar no SQL editor do Supabase. ROLLBACK reversível em db/rollback/005_indexed_pricing.down.sql.

CREATE TABLE IF NOT EXISTS mesa_indexed_pricing (
  mesa_id               text    NOT NULL,
  terms_version         integer NOT NULL,                 -- versão dos termos (zera assinaturas ao incrementar)
  mode                  text    NOT NULL,                 -- FIXED | INDEXED_VERUM_SWAP
  index_source          text    NOT NULL DEFAULT 'VERUM_SWAP',
  spread_bps            integer NOT NULL DEFAULT 0,        -- inteiro COM sinal (limites configuráveis)
  max_move_bps          integer NOT NULL DEFAULT 100,
  fixing_ttl_sec        integer NOT NULL DEFAULT 600,
  status                text    NOT NULL DEFAULT 'CONFIGURED', -- CONFIGURED | FIXED | LOCKED | CANCELLED
  base_amount           text,                             -- quantidade do VENDEDOR (unidades mínimas), bigint-string
  fixing_price_e18      text,                             -- preço final (com spread), escala 1e18
  fixing_sources        jsonb,                            -- fontes do índice (provedor + priceE18 + quoteId)
  fixing_dispersion_bps text,
  quote_amount          text,                             -- quantidade do COMPRADOR (unidades mínimas)
  rounding_residual     text,                             -- resíduo explícito do arredondamento para baixo
  fixing_hash           text,                             -- SHA-256 do JSON canônico do fixing
  fixed_at              bigint,
  fixing_expires_at     bigint,
  created_by            text    NOT NULL,
  created_at            bigint  NOT NULL,
  updated_at            bigint  NOT NULL,
  PRIMARY KEY (mesa_id, terms_version),
  CHECK (terms_version >= 1)
);
CREATE INDEX IF NOT EXISTS mesa_indexed_pricing_mesa ON mesa_indexed_pricing (mesa_id);

-- Imutabilidade pós-LOCK: rejeita UPDATE/DELETE quando a linha JÁ está travada (a transição
-- FIXED→LOCKED é permitida porque OLD.status ainda não é 'LOCKED'). Refixar cria uma NOVA versão.
CREATE OR REPLACE FUNCTION reject_locked_indexed_pricing() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'LOCKED' THEN
    RAISE EXCEPTION 'mesa_indexed_pricing travado (LOCKED) é imutável: % em (%, %)', TG_OP, OLD.mesa_id, OLD.terms_version;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mesa_indexed_pricing_lock_immutable ON mesa_indexed_pricing;
CREATE TRIGGER mesa_indexed_pricing_lock_immutable BEFORE UPDATE OR DELETE ON mesa_indexed_pricing
  FOR EACH ROW EXECUTE FUNCTION reject_locked_indexed_pricing();

-- RLS habilitado SEM policies: nenhum acesso pela API pública do Supabase; o backend conecta por
-- conexão Postgres direta (como deals/mesa_invites).
ALTER TABLE mesa_indexed_pricing ENABLE ROW LEVEL SECURITY;
