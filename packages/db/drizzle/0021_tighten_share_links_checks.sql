ALTER TABLE "share_links" DROP CONSTRAINT "share_links_target_type_check";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_access_level_check";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_target_type_check" CHECK ("share_links"."target_type" in ('artifact', 'thread'));--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_access_level_check" CHECK ("share_links"."access_level" in ('viewer'));