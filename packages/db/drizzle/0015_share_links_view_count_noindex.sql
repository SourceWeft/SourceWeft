ALTER TABLE "share_links" ADD COLUMN "noindex" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_active_target_uq" ON "share_links" USING btree ("target_type","target_id") WHERE "share_links"."revoked_at" is null;