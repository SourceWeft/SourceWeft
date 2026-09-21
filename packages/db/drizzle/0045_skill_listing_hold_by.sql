ALTER TABLE "skill_definitions" ADD COLUMN "listing_hold_by" text;--> statement-breakpoint
-- Every hold that exists was placed by a market admin: until now nobody else
-- could place one. Filled in before the check below, which requires it.
UPDATE "skill_definitions" SET "listing_hold_by" = 'admin' WHERE "listing_hold" = true AND "listing_hold_by" IS NULL;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_listing_hold_by_check" CHECK (("skill_definitions"."listing_hold" = false and "skill_definitions"."listing_hold_by" is null) or ("skill_definitions"."listing_hold" = true and "skill_definitions"."listing_hold_by" in ('admin', 'owner')));