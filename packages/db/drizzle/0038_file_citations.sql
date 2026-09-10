ALTER TABLE "citations" DROP CONSTRAINT "citations_target_check";
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_target_check" CHECK (((("citations"."chunk_id" is not null or "citations"."external_uri" is not null) and "citations"."metadata_json"->'fileReference' is null) or ("citations"."metadata_json"->>'origin' = 'file' and jsonb_typeof("citations"."metadata_json"->'fileReference') = 'object' and "citations"."chunk_id" is null and "citations"."external_uri" is null and "citations"."source_id" is null and "citations"."document_id" is null)) is true);
