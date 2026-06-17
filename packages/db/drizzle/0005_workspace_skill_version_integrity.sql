DELETE FROM "workspace_skills"
WHERE NOT EXISTS (
	SELECT 1
	FROM "skill_versions"
	WHERE "skill_versions"."id" = "workspace_skills"."skill_version_id"
		AND "skill_versions"."skill_id" = "workspace_skills"."skill_id"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_id_skill_uq" ON "skill_versions" USING btree ("id","skill_id");
--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_skill_version_skill_fk" FOREIGN KEY ("skill_version_id","skill_id") REFERENCES "public"."skill_versions"("id","skill_id") ON DELETE cascade ON UPDATE no action;
