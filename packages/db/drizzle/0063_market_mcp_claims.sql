CREATE TABLE "market_mcp_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target" text NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"last_error" text,
	CONSTRAINT "market_mcp_claims_method_check" CHECK ("market_mcp_claims"."method" in ('github', 'dns_txt', 'well_known')),
	CONSTRAINT "market_mcp_claims_status_check" CHECK ("market_mcp_claims"."status" in ('pending', 'verified', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "market_mcp_owner_overrides" (
	"server_id" text PRIMARY KEY NOT NULL,
	"updated_by" text NOT NULL,
	"overrides_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tools_json" jsonb,
	"tools_meta_json" jsonb,
	"tools_submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_mcp_claims" ADD CONSTRAINT "market_mcp_claims_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_mcp_owner_overrides" ADD CONSTRAINT "market_mcp_owner_overrides_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_mcp_claims_verified_uq" ON "market_mcp_claims" USING btree ("server_id","user_id") WHERE "market_mcp_claims"."status" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "market_mcp_claims_pending_uq" ON "market_mcp_claims" USING btree ("server_id","user_id") WHERE "market_mcp_claims"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "market_mcp_claims_server_status_idx" ON "market_mcp_claims" USING btree ("server_id","status");--> statement-breakpoint
CREATE INDEX "market_mcp_claims_user_idx" ON "market_mcp_claims" USING btree ("user_id");