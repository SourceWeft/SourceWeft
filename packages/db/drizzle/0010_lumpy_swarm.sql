ALTER TABLE "artifacts" ADD COLUMN "current_version_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "request_key" text;--> statement-breakpoint
-- Backfill the version pointer from the table that owns version numbers.
-- Rows with no versions at all (a pending artifact that never published) keep
-- the 0 default, which is exactly what "no published version yet" means.
UPDATE "artifacts" AS "a"
SET "current_version_no" = "v"."max_version_no"
FROM (
  SELECT "artifact_id", max("version_no") AS "max_version_no"
  FROM "artifact_versions"
  GROUP BY "artifact_id"
) AS "v"
WHERE "v"."artifact_id" = "a"."id";--> statement-breakpoint
-- Lift the idempotency token out of payload_json, where video_presentation is
-- the only writer that has ever set one, so existing rows stay reusable once
-- the reuse lookup matches the column instead of scanning payloads.
-- jsonb_typeof rather than the `?` containment operator: `?` is a bind
-- placeholder to the driver that runs these files.
UPDATE "artifacts"
SET "request_key" = "payload_json"->>'requestKey'
WHERE jsonb_typeof("payload_json"->'requestKey') = 'string';--> statement-breakpoint
-- Non-unique on purpose: a unique index here would have to ignore status, so a
-- retried two-phase open would collide with its own in-flight pending row. It
-- also could not be built at all over whatever duplicate request keys the
-- pre-existing 20-row reuse scan already let through.
-- Not CONCURRENTLY: `drizzle-kit migrate` runs each file inside a transaction,
-- and CREATE INDEX CONCURRENTLY cannot run in one. This build takes a lock that
-- blocks writes to `artifacts` for its duration. On a small table that is
-- imperceptible; if this table has grown large, drop this statement and build
-- the index out of band instead:
--   CREATE INDEX CONCURRENTLY "artifacts_workspace_type_request_key_idx"
--     ON "artifacts" ("workspace_id","artifact_type","request_key")
--     WHERE "request_key" IS NOT NULL;
CREATE INDEX "artifacts_workspace_type_request_key_idx" ON "artifacts" USING btree ("workspace_id","artifact_type","request_key") WHERE "artifacts"."request_key" is not null;--> statement-breakpoint
-- NOT VALID so adding the constraint does not scan the whole table under an
-- ACCESS EXCLUSIVE lock. It is enforced for every new and updated row from this
-- point on; the backfill above only ever writes max(version_no) >= 1 and the
-- column default is 0, so existing rows already satisfy it. To mark the history
-- verified as well, run this once out of band under a weaker lock:
--   ALTER TABLE "artifacts" VALIDATE CONSTRAINT "artifacts_current_version_no_check";
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_current_version_no_check" CHECK ("artifacts"."current_version_no" >= 0) NOT VALID;
