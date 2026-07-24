ALTER TABLE "market_items" ADD COLUMN "transport" text;--> statement-breakpoint
ALTER TABLE "market_items" ADD COLUMN "official" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "market_items" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "market_items" ADD COLUMN "desktop_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "market_items" ADD COLUMN "runtime" text;--> statement-breakpoint
CREATE INDEX "market_items_browse_idx" ON "market_items" USING btree ("kind","status","visibility","published_at" desc,"id" desc);--> statement-breakpoint
-- Backfill the promoted facet columns from existing metadata_json. Defaults
-- mirror the app mapping: official/verified/desktopOnly default false,
-- webExecutable defaults true, runtime is derived from desktopOnly+webExecutable.
UPDATE "market_items" SET
  "transport" = "metadata_json"->>'transport',
  "official" = COALESCE(NULLIF("metadata_json"->>'official', '')::boolean, false),
  "verified" = COALESCE(NULLIF("metadata_json"->>'verified', '')::boolean, false),
  "desktop_only" = COALESCE(NULLIF("metadata_json"->>'desktopOnly', '')::boolean, false),
  "runtime" = CASE
    WHEN COALESCE(NULLIF("metadata_json"->>'desktopOnly', '')::boolean, false)
         AND COALESCE(NULLIF("metadata_json"->>'webExecutable', '')::boolean, true) THEN 'hybrid'
    WHEN COALESCE(NULLIF("metadata_json"->>'desktopOnly', '')::boolean, false)
         OR NOT COALESCE(NULLIF("metadata_json"->>'webExecutable', '')::boolean, true) THEN 'desktop'
    ELSE 'web'
  END;