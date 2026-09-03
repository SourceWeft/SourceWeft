-- Registry skills now store their bundle like every other skill (`db_text`)
-- instead of holding a bare pointer and re-fetching from GitHub each turn.
--
-- A `pointer` version persisted ZERO `skill_version_files` rows by design, so
-- these rows carry no recoverable content — nothing is lost by removing them,
-- and the skill is re-indexed by re-submitting its repo URL. They must go
-- before the CHECK is narrowed, or the constraint would fail to validate.
DELETE FROM "workspace_skills"
WHERE "skill_version_id" IN (
  SELECT "id" FROM "skill_versions" WHERE "storage_type" = 'pointer'
);--> statement-breakpoint

DELETE FROM "skill_versions" WHERE "storage_type" = 'pointer';--> statement-breakpoint

-- Definitions left with no versions at all are orphaned index entries.
DELETE FROM "skill_definitions"
WHERE "source_type" = 'registry_github'
  AND NOT EXISTS (
    SELECT 1 FROM "skill_versions"
    WHERE "skill_versions"."skill_id" = "skill_definitions"."id"
  );--> statement-breakpoint

ALTER TABLE "skill_versions" DROP CONSTRAINT "skill_versions_storage_type_check";--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_storage_type_check" CHECK ("skill_versions"."storage_type" in ('repo_builtin', 'db_text'));
