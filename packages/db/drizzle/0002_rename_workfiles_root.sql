ALTER TABLE "working_files" DROP CONSTRAINT IF EXISTS "working_files_path_check";
--> statement-breakpoint
UPDATE "working_files"
SET "path" = regexp_replace("path", '^/work/', '/workfiles/')
WHERE "path" LIKE '/work/%';
--> statement-breakpoint
UPDATE "messages"
SET
  "content" = regexp_replace("content", '(^|[^[:alnum:]_/.-])/work/', '\1/workfiles/', 'g'),
  "content_json" = regexp_replace("content_json"::text, '(^|[^[:alnum:]_/.-])/work/', '\1/workfiles/', 'g')::jsonb,
  "metadata" = regexp_replace("metadata"::text, '(^|[^[:alnum:]_/.-])/work/', '\1/workfiles/', 'g')::jsonb
WHERE
  "content" ~ '(^|[^[:alnum:]_/.-])/work/'
  OR "content_json"::text ~ '(^|[^[:alnum:]_/.-])/work/'
  OR "metadata"::text ~ '(^|[^[:alnum:]_/.-])/work/';
--> statement-breakpoint
UPDATE "chat_thread_runs"
SET
  "request_json" = regexp_replace("request_json"::text, '(^|[^[:alnum:]_/.-])/work/', '\1/workfiles/', 'g')::jsonb,
  "snapshot_json" = regexp_replace("snapshot_json"::text, '(^|[^[:alnum:]_/.-])/work/', '\1/workfiles/', 'g')::jsonb
WHERE
  "request_json"::text ~ '(^|[^[:alnum:]_/.-])/work/'
  OR "snapshot_json"::text ~ '(^|[^[:alnum:]_/.-])/work/';
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_path_check" CHECK ("working_files"."path" ~ '^/workfiles/[^[:cntrl:]]+$' and "working_files"."path" not like '%..%' and "working_files"."path" not like '%~%' and "working_files"."path" not like '%//%');
