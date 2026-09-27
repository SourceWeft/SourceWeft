-- AI overviews of MCP servers (Issue #152): per-locale overviews and the
-- generation state, built from the column definitions skills use, both
-- cascading from mcp_server_versions. New tables only; nothing is backfilled.
CREATE TABLE "mcp_server_version_analysis" (
	"mcp_server_version_id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"status" text NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"result_key" text,
	"model_configuration_key" text,
	"prompt_version" text,
	"taxonomy_version" text,
	"classification" jsonb,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_version_analysis_status_check" CHECK ("mcp_server_version_analysis"."status" in ('pending','running','ready','failed','needs-review'))
);
--> statement-breakpoint
CREATE TABLE "mcp_server_version_overviews" (
	"mcp_server_version_id" text NOT NULL,
	"locale" text NOT NULL,
	"input_sha256" text NOT NULL,
	"overview" jsonb NOT NULL,
	"model" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_version_overviews_pk" PRIMARY KEY("mcp_server_version_id","locale"),
	CONSTRAINT "mcp_server_version_overviews_locale_check" CHECK ("mcp_server_version_overviews"."locale" in ('en', 'zh-CN', 'zh-TW'))
);
--> statement-breakpoint
ALTER TABLE "mcp_server_version_analysis" ADD CONSTRAINT "mcp_server_version_analysis_mcp_server_version_id_mcp_server_versions_id_fk" FOREIGN KEY ("mcp_server_version_id") REFERENCES "public"."mcp_server_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_version_overviews" ADD CONSTRAINT "mcp_server_version_overviews_mcp_server_version_id_mcp_server_versions_id_fk" FOREIGN KEY ("mcp_server_version_id") REFERENCES "public"."mcp_server_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_server_version_analysis_result_idx" ON "mcp_server_version_analysis" USING btree ("result_key");