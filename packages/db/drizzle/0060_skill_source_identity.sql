ALTER TABLE "skill_definitions" ADD COLUMN "github_repository_id" text;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "source_root" text;--> statement-breakpoint
-- Preserve public slugs and IDs for the path served by the existing page.
-- Other exact source paths become independent definitions; version IDs survive.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM skill_definitions d JOIN skill_versions v ON v.skill_id=d.id
    WHERE d.source_type='registry_github' AND v.storage_pointer !~ '^github:[^/@#[:space:]]+/[^/@#[:space:]]+@[a-fA-F0-9]{40}(#.*)?$') THEN
    RAISE EXCEPTION 'Registry history has invalid source pointers; repair before identity migration';
  END IF;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE registry_source_mapping ON COMMIT DROP AS
WITH roots AS (
 SELECT DISTINCT d.id old_id, coalesce(substring(v.storage_pointer from '#(.*)$'),'') source_root
 FROM skill_definitions d JOIN skill_versions v ON v.skill_id=d.id WHERE d.source_type='registry_github'
), primary_roots AS (
 SELECT DISTINCT ON (d.id) d.id, coalesce(substring(v.storage_pointer from '#(.*)$'),'') source_root
 FROM skill_definitions d JOIN skill_versions v ON v.skill_id=d.id WHERE d.source_type='registry_github'
 ORDER BY d.id, v.is_current DESC, v.created_at DESC, v.id DESC
)
SELECT roots.old_id, roots.source_root,
 CASE WHEN roots.source_root=primary_roots.source_root THEN roots.old_id ELSE gen_random_uuid()::text END new_id
FROM roots JOIN primary_roots ON primary_roots.id=roots.old_id;
--> statement-breakpoint
-- Encode path bytes using the same unreserved characters as encodeURIComponent;
-- slash remains a directory separator. Temporary function leaves no schema API.
CREATE OR REPLACE FUNCTION pg_temp.registry_source_path(value text) RETURNS text
LANGUAGE SQL IMMUTABLE STRICT AS $$
 SELECT coalesce(string_agg(
  CASE WHEN get_byte(convert_to(value,'UTF8'),i) BETWEEN 48 AND 57
    OR get_byte(convert_to(value,'UTF8'),i) BETWEEN 65 AND 90
    OR get_byte(convert_to(value,'UTF8'),i) BETWEEN 97 AND 122
    OR get_byte(convert_to(value,'UTF8'),i) IN (33,39,40,41,42,45,46,47,95,126)
   THEN chr(get_byte(convert_to(value,'UTF8'),i))
   ELSE '%'||upper(lpad(to_hex(get_byte(convert_to(value,'UTF8'),i)),2,'0')) END,
  '' ORDER BY i),'') FROM generate_series(0,octet_length(convert_to(value,'UTF8'))-1) i;
$$;
--> statement-breakpoint
UPDATE skill_definitions d SET source_root=m.source_root,
 github_repository_id=r.github_id
FROM registry_source_mapping m LEFT JOIN skill_definitions original ON original.id=m.old_id
 LEFT JOIN skill_repositories r ON r.repo_owner=original.repo_owner AND r.repo_name=original.repo_name
WHERE d.id=m.old_id AND m.new_id=m.old_id;
--> statement-breakpoint
INSERT INTO skill_definitions
SELECT (jsonb_populate_record(NULL::skill_definitions,
 to_jsonb(d) || jsonb_build_object(
  'id',m.new_id,'slug',left(d.slug,160)||'-'||coalesce(nullif(left(trim(both '-' from regexp_replace(lower(m.source_root),'[^a-z0-9]+','-','g')),64),''),'root')||'-'||left(md5(m.source_root),16),
  'source_root',m.source_root,'verified',false,'install_count',0,'rating_count',0,'rating_avg',NULL,'rank_score',0,'categories_set_by',NULL,
  'display_name',v.manifest_json->>'displayName','description',v.manifest_json->>'description'
 ))).* FROM registry_source_mapping m JOIN skill_definitions d ON d.id=m.old_id
 JOIN LATERAL (SELECT manifest_json FROM skill_versions WHERE skill_id=m.old_id AND coalesce(substring(storage_pointer from '#(.*)$'),'')=m.source_root ORDER BY is_current DESC,created_at DESC,id DESC LIMIT 1) v ON true
WHERE m.new_id<>m.old_id;
--> statement-breakpoint
ALTER TABLE workspace_skills ALTER CONSTRAINT workspace_skills_skill_version_skill_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
UPDATE skill_versions v SET skill_id=m.new_id,
 manifest_json=jsonb_set(jsonb_set(jsonb_set(v.manifest_json,'{slug}',to_jsonb(d.slug)),'{registry,sourceRoot}',to_jsonb(m.source_root)),
 '{registry,sourceUrl}',to_jsonb('https://github.com/'||substring(v.storage_pointer from '^github:([^@]+)@')||'/tree/'||substring(v.storage_pointer from '@([a-fA-F0-9]{40})')||CASE WHEN m.source_root='' THEN '' ELSE '/'||pg_temp.registry_source_path(m.source_root) END))
FROM registry_source_mapping m JOIN skill_definitions d ON d.id=m.new_id
WHERE v.skill_id=m.old_id AND coalesce(substring(v.storage_pointer from '#(.*)$'),'')=m.source_root;
--> statement-breakpoint
UPDATE workspace_skills w SET skill_id=v.skill_id FROM skill_versions v
WHERE w.skill_version_id=v.id AND w.skill_id<>v.skill_id;
--> statement-breakpoint
SET CONSTRAINTS workspace_skills_skill_version_skill_fk IMMEDIATE;
--> statement-breakpoint
ALTER TABLE workspace_skills ALTER CONSTRAINT workspace_skills_skill_version_skill_fk NOT DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
UPDATE skill_reviews r SET skill_id=v.skill_id FROM skill_versions v WHERE r.skill_version_id=v.id AND r.skill_id<>v.skill_id;
--> statement-breakpoint
UPDATE skill_run_events e SET skill_id=v.skill_id FROM skill_versions v WHERE e.skill_version_id=v.id AND e.skill_id<>v.skill_id;
--> statement-breakpoint
-- Existing access grants covered these historical versions; preserve scope/expiry.
INSERT INTO skill_entitlements(id,skill_id,team_id,workspace_id,expires_at,granted_by,created_at)
SELECT gen_random_uuid()::text,m.new_id,e.team_id,e.workspace_id,e.expires_at,e.granted_by,e.created_at
FROM registry_source_mapping m JOIN skill_entitlements e ON e.skill_id=m.old_id WHERE m.new_id<>m.old_id;
--> statement-breakpoint
-- Select the newest published version for split paths only; preserve revocation.
WITH chosen AS (
 SELECT DISTINCT ON(v.skill_id) v.id FROM skill_versions v JOIN registry_source_mapping m ON m.new_id=v.skill_id AND m.new_id<>m.old_id
 WHERE v.status='published' ORDER BY v.skill_id,coalesce((v.manifest_json->'registry'->>'committedAt')::timestamptz,v.created_at) DESC,v.created_at DESC,v.id DESC
) UPDATE skill_versions SET is_current=true WHERE id IN (SELECT id FROM chosen);
--> statement-breakpoint
INSERT INTO skill_market_events(id,skill_id,actor_kind,action,detail)
SELECT gen_random_uuid()::text,new_id,'system','source.identity.migrated',jsonb_build_object('oldSkillId',old_id,'sourceRoot',source_root,'preservedId',old_id=new_id)
FROM registry_source_mapping;
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_definitions_github_source_uq" ON "skill_definitions" USING btree ("github_repository_id","source_root") WHERE "skill_definitions"."source_type" = 'registry_github' and "skill_definitions"."github_repository_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_definitions_github_path_uq" ON "skill_definitions" USING btree ("repo_owner","repo_name","source_root") WHERE "skill_definitions"."source_type" = 'registry_github' and "skill_definitions"."source_root" is not null and "skill_definitions"."github_repository_id" is null;