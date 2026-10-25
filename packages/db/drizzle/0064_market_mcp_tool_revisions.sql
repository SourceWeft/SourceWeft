CREATE TABLE "market_mcp_tool_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"source" text NOT NULL,
	"revision" integer NOT NULL,
	"tools_hash" text NOT NULL,
	"canonical_version" integer NOT NULL,
	"withdrawn" boolean DEFAULT false NOT NULL,
	"tools_count" integer DEFAULT 0 NOT NULL,
	"tools_json" jsonb,
	"diff_json" jsonb NOT NULL,
	"server_version" text,
	"observed_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_mcp_tool_revisions_source_check" CHECK ("market_mcp_tool_revisions"."source" in ('owner', 'platform-indexed', 'member-observed')),
	CONSTRAINT "market_mcp_tool_revisions_revision_check" CHECK ("market_mcp_tool_revisions"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "market_mcp_tool_revisions" ADD CONSTRAINT "market_mcp_tool_revisions_item_id_mcp_servers_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_mcp_tool_revisions_item_source_revision_uq" ON "market_mcp_tool_revisions" USING btree ("item_id","source","revision");