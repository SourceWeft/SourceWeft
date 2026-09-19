ALTER TABLE "local_tool_invocations" ALTER COLUMN "thread_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "local_tool_invocations" ADD CONSTRAINT "local_invocation_scope" CHECK (
  (thread_id IS NOT NULL AND action NOT IN ('folder.list', 'folder.read')) OR
  (thread_id IS NULL AND action IN ('folder.list', 'folder.read') AND payload ? 'folderId' AND jsonb_typeof(payload->'folderId') = 'string' AND length(payload->>'folderId') > 0)
);
