CREATE INDEX IF NOT EXISTS "chunks_bm25_universal_idx"
ON "chunks"
USING bm25 ("search_parts")
WITH (text_config = 'simple');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunk_embeddings_global_embedding_bge_m3_1024_hnsw_idx"
ON "chunk_embeddings"
USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
WHERE "embedding_profile_id" = 'global:embedding:bge-m3-1024' AND "dim" = 1024;
