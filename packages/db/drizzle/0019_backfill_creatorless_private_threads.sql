-- A private thread with no recorded creator predates creator tracking. Until
-- now `canViewThread` special-cased these as shared (visible to the whole
-- workspace) while `canViewContent` hid the artifacts they produced — the two
-- rules disagreed about the same rows. Make the data say what the code was
-- pretending: such threads ARE workspace-visible. After this backfill the
-- null-creator branch is removed from the code and `private` always means
-- "creator only", fail-closed.
UPDATE "artifacts" a
SET "visibility" = 'workspace'
FROM "threads" t
WHERE a."thread_id" = t."id"
  AND t."visibility" = 'private'
  AND t."created_by" IS NULL
  AND a."visibility" = 'private';--> statement-breakpoint
UPDATE "threads"
SET "visibility" = 'workspace'
WHERE "visibility" = 'private'
  AND "created_by" IS NULL;
