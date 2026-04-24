CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_search;
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

CREATE INDEX IF NOT EXISTS "chunk_embeddings_global_embedding_bge_m3_1024_hnsw_idx"
ON "chunk_embeddings"
USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
WHERE "embedding_profile_id" = 'global:embedding:bge-m3-1024' AND "dim" = 1024;
