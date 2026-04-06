CREATE EXTENSION IF NOT EXISTS pg_search;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

INSERT INTO "embedding_profiles" (
  "id",
  "alias",
  "provider_kind",
  "provider_model_alias",
  "requested_dimensions",
  "vector_strategy",
  "is_default",
  "is_active",
  "config_json"
)
VALUES (
  'embed-default',
  'embed-default',
  'litellm',
  'embed-default',
  1536,
  'auto',
  true,
  true,
  '{}'::jsonb
)
ON CONFLICT ("alias") DO NOTHING;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "chunks_bm25_idx"
ON "chunks"
USING bm25 (
  "id",
  "team_id",
  "workspace_id",
  "source_id",
  "document_id",
  ("content"::pdb.icu),
  ("language"::pdb.literal),
  "created_at"
)
WITH (key_field = 'id');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documents_bm25_idx"
ON "documents"
USING bm25 (
  "id",
  "team_id",
  "workspace_id",
  "source_id",
  ("title"::pdb.icu),
  ("language"::pdb.literal),
  "updated_at"
)
WITH (key_field = 'id');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "chunk_embeddings_embed_default_1536_hnsw_idx"
ON "chunk_embeddings"
USING hnsw (("embedding"::vector(1536)) vector_cosine_ops)
WHERE "embedding_profile_id" = 'embed-default' AND "dim" = 1536;