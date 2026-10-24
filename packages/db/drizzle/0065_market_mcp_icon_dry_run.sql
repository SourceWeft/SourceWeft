CREATE TABLE "market_mcp_icon_fetch_state" (
	"scope" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"result_json" jsonb,
	"error_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	CONSTRAINT "market_mcp_icon_fetch_state_status_check" CHECK ("market_mcp_icon_fetch_state"."status" in ('ok', 'denied', 'deferred', 'error'))
);
--> statement-breakpoint
CREATE TABLE "market_mcp_icon_hash_domains" (
	"sha256" text NOT NULL,
	"domain" text NOT NULL,
	"label" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_mcp_icon_hash_domains_pk" PRIMARY KEY("sha256","domain")
);
