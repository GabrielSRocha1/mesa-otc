-- VERUM OTC · migração inicial (PostgreSQL 16 / PGlite)
-- Projeção da Deal em JSONB + colunas indexadas; eventos e auditoria append-only; unicidade de liquidação.
CREATE TABLE IF NOT EXISTS deals (
  id            TEXT PRIMARY KEY,
  version       INTEGER NOT NULL,
  state         TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  deal_hash     TEXT,
  created_by    TEXT NOT NULL,
  share_token   TEXT NOT NULL UNIQUE,
  expires_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  doc           JSONB NOT NULL,
  CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS deals_state_expires ON deals (state, expires_at);
CREATE INDEX IF NOT EXISTS deals_created_by ON deals (created_by);

CREATE TABLE IF NOT EXISTS deal_events (
  deal_id   TEXT NOT NULL REFERENCES deals(id),
  seq       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  at        BIGINT NOT NULL,
  actor     TEXT NOT NULL,
  payload   JSONB NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL,
  PRIMARY KEY (deal_id, seq)
);

CREATE TABLE IF NOT EXISTS signatures (
  id            TEXT PRIMARY KEY,
  deal_id       TEXT NOT NULL REFERENCES deals(id),
  revision      INTEGER NOT NULL,
  role          TEXT NOT NULL,
  signer        TEXT NOT NULL,
  scheme        TEXT NOT NULL,
  signed_hash   TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  status        TEXT NOT NULL,
  received_at   BIGINT NOT NULL,
  doc           JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signatures_valid_unique ON signatures (deal_id, revision, role) WHERE status = 'valid';

CREATE TABLE IF NOT EXISTS nonces (
  value        TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  deal_id      TEXT,
  revision     INTEGER,
  role         TEXT,
  issued_at    BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  consumed_at  BIGINT
);

CREATE TABLE IF NOT EXISTS settlements (
  deal_id       TEXT PRIMARY KEY REFERENCES deals(id),
  revision      INTEGER NOT NULL,
  lock_token    TEXT NOT NULL,
  status        TEXT NOT NULL,
  started_at    BIGINT NOT NULL,
  doc           JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  id        TEXT PRIMARY KEY,
  deal_id   TEXT,
  wallet    TEXT,
  rule      TEXT NOT NULL,
  severity  TEXT NOT NULL,
  decision  TEXT NOT NULL,
  at        BIGINT NOT NULL,
  evidence  JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq          BIGINT PRIMARY KEY,
  at           BIGINT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  category     TEXT NOT NULL,
  deal_id      TEXT,
  payload_hash TEXT NOT NULL,
  payload      JSONB NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response     JSONB NOT NULL,
  created_at   BIGINT NOT NULL,
  PRIMARY KEY (key, actor_id)
);

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only table: % on %', TG_OP, TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS deal_events_append_only ON deal_events;
CREATE TRIGGER deal_events_append_only BEFORE UPDATE OR DELETE ON deal_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
