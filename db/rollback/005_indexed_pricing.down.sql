-- ROLLBACK de 005_indexed_pricing.sql (Operar Indexado). NÃO fica em db/migrations/ de propósito: o
-- runner de boot (src/db/sqlStore.ts) executa TODO *.sql de db/migrations em ordem — um .down.sql ali
-- dropparia a tabela a cada boot. Rode este script MANUALMENTE (psql / SQL editor do Supabase) para
-- reverter a feature. É aditiva: dropar isto NÃO afeta nada do fluxo FIXED existente.

DROP TRIGGER IF EXISTS mesa_indexed_pricing_lock_immutable ON mesa_indexed_pricing;
DROP FUNCTION IF EXISTS reject_locked_indexed_pricing();
DROP TABLE IF EXISTS mesa_indexed_pricing;
