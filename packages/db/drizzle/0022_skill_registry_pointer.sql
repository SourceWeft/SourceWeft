-- Skill registry discriminators (docs/architecture/skill-registry-index.md §2):
-- sourceType gains 'registry_github' (shared cross-workspace catalog entry,
-- same scope shape as builtin) and storageType gains 'pointer' (content
-- fetched-on-use from the pinned upstream commit; a pointer version has ZERO
-- skill_version_files rows — enforced in the repository layer, invariant 2).
ALTER TABLE "skill_definitions" DROP CONSTRAINT "skill_definitions_source_type_check";--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_source_type_check" CHECK ("skill_definitions"."source_type" in ('builtin', 'workspace_custom', 'team_custom', 'registry_github'));--> statement-breakpoint
ALTER TABLE "skill_definitions" DROP CONSTRAINT "skill_definitions_scope_check";--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_scope_check" CHECK (("skill_definitions"."source_type" = 'builtin' and "skill_definitions"."team_id" is null and "skill_definitions"."workspace_id" is null and "skill_definitions"."visibility" in ('public', 'restricted')) or ("skill_definitions"."source_type" = 'workspace_custom' and "skill_definitions"."team_id" is not null and "skill_definitions"."workspace_id" is not null and "skill_definitions"."visibility" = 'workspace') or ("skill_definitions"."source_type" = 'team_custom' and "skill_definitions"."team_id" is not null and "skill_definitions"."workspace_id" is null and "skill_definitions"."visibility" = 'team') or ("skill_definitions"."source_type" = 'registry_github' and "skill_definitions"."team_id" is null and "skill_definitions"."workspace_id" is null and "skill_definitions"."visibility" in ('public', 'restricted')));--> statement-breakpoint
ALTER TABLE "skill_versions" DROP CONSTRAINT "skill_versions_storage_type_check";--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_storage_type_check" CHECK ("skill_versions"."storage_type" in ('repo_builtin', 'db_text', 'pointer'));
