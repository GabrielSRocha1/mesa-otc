-- VERUM OTC · migração 002 (hardening): índices para filtros empurrados ao SQL, retenção e vínculo do nonce ao sujeito.
ALTER TABLE nonces ADD COLUMN IF NOT EXISTS subject TEXT;
CREATE INDEX IF NOT EXISTS nonces_open_lookup ON nonces (deal_id, revision, role) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS nonces_expires ON nonces (expires_at);
CREATE INDEX IF NOT EXISTS deals_participants_gin ON deals USING GIN ((doc->'participants') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS deals_updated_at ON deals (updated_at DESC);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS risk_events_deal ON risk_events (deal_id, at);
CREATE INDEX IF NOT EXISTS audit_events_deal ON audit_events (deal_id, seq);
