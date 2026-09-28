-- 003_portal.sql — Persistência do Portal Pay Master (Supabase/Postgres).
-- Substitui o arquivo JSON efêmero do serverless (que perdia sessão entre invocações na
-- Vercel → "volta pro login"). O estado do portal (pay masters, sessões, códigos, convites,
-- 2FA/segurança, alertas) é guardado como UM documento JSONB — preserva integralmente a
-- lógica já testada do PortalService; a normalização por-entidade pode vir depois.
-- Idempotente: pode rodar no SQL editor do Supabase.

CREATE TABLE IF NOT EXISTS portal_state (
  id         text PRIMARY KEY,      -- 'singleton' (um documento)
  doc        jsonb NOT NULL,        -- PortalData completo
  updated_at bigint NOT NULL
);

-- RLS habilitado SEM policies: nenhum acesso via API pública (anon/authenticated do PostgREST).
-- O backend do OTC conecta por CONEXÃO POSTGRES DIRETA (role postgres), que ignora RLS — os
-- dados sensíveis (pass_hash, e-mail, carteiras) nunca ficam expostos ao anon do projeto.
ALTER TABLE portal_state ENABLE ROW LEVEL SECURITY;
