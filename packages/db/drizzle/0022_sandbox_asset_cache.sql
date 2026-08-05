CREATE TABLE "sandbox_asset_cache" (
	"name" text NOT NULL,
	"version" text NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sha256" text NOT NULL,
	"storage_bucket" text,
	"storage_key" text,
	"size_bytes" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_asset_cache_pk" PRIMARY KEY("name","version","platform"),
	CONSTRAINT "sandbox_asset_cache_status_check" CHECK ("sandbox_asset_cache"."status" IN ('pending', 'ready', 'failed'))
);
