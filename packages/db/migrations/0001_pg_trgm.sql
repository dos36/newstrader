-- Custom SQL migration file, put your code below! --

-- pg_trgm powers step 2 of attachItemToCluster (packages/db/src/clustering-repo.ts):
-- candidates are pre-filtered with the % operator (under SET LOCAL
-- pg_trgm.similarity_threshold) — that operator is what makes this GIN index
-- usable; bare similarity() calls always sequential-scan — then exact-scored
-- and ordered by similarity().
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clusters_normalized_headline_trgm_idx ON news_clusters USING gin (normalized_headline gin_trgm_ops);
