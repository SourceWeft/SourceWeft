ALTER TABLE "skill_definitions" ADD COLUMN "install_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_definitions_install_ref_uq" ON "skill_definitions" USING btree ("install_ref");