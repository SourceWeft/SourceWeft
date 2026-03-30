CREATE TABLE IF NOT EXISTS "billing_accounts" (
	"team_id" text PRIMARY KEY NOT NULL,
	"plan_family" text NOT NULL,
	"cycle_anchor_day" integer DEFAULT 1 NOT NULL,
	"cycle_start_at" timestamp with time zone NOT NULL,
	"cycle_end_at" timestamp with time zone NOT NULL,
	"pages_limit" integer NOT NULL,
	"pages_used" integer DEFAULT 0 NOT NULL,
	"monthly_credits_grant" integer NOT NULL,
	"monthly_credits_balance" integer NOT NULL,
	"add_on_credits_balance" integer DEFAULT 0 NOT NULL,
	"credits_reserved" integer DEFAULT 0 NOT NULL,
	"credits_consumed_this_cycle" integer DEFAULT 0 NOT NULL,
	"spend_soft_cap_usd" numeric(12, 4),
	"spend_hard_cap_usd" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_cycle_anchor_day_check" CHECK ("billing_accounts"."cycle_anchor_day" between 1 and 28),
	CONSTRAINT "billing_accounts_pages_limit_check" CHECK ("billing_accounts"."pages_limit" >= 0),
	CONSTRAINT "billing_accounts_pages_used_check" CHECK ("billing_accounts"."pages_used" >= 0),
	CONSTRAINT "billing_accounts_monthly_grant_check" CHECK ("billing_accounts"."monthly_credits_grant" >= 0),
	CONSTRAINT "billing_accounts_monthly_balance_check" CHECK ("billing_accounts"."monthly_credits_balance" >= 0),
	CONSTRAINT "billing_accounts_add_on_balance_check" CHECK ("billing_accounts"."add_on_credits_balance" >= 0),
	CONSTRAINT "billing_accounts_reserved_check" CHECK ("billing_accounts"."credits_reserved" >= 0),
	CONSTRAINT "billing_accounts_consumed_check" CHECK ("billing_accounts"."credits_consumed_this_cycle" >= 0),
	CONSTRAINT "billing_accounts_soft_cap_check" CHECK ("billing_accounts"."spend_soft_cap_usd" is null or "billing_accounts"."spend_soft_cap_usd" >= 0),
	CONSTRAINT "billing_accounts_hard_cap_check" CHECK ("billing_accounts"."spend_hard_cap_usd" is null or "billing_accounts"."spend_hard_cap_usd" >= 0),
	CONSTRAINT "billing_accounts_hard_gte_soft_check" CHECK ("billing_accounts"."spend_soft_cap_usd" is null or "billing_accounts"."spend_hard_cap_usd" is null or "billing_accounts"."spend_hard_cap_usd" >= "billing_accounts"."spend_soft_cap_usd")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_by" text,
	"model" text,
	"credits_consumed" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'system')),
	CONSTRAINT "messages_credits_consumed_check" CHECK ("messages"."credits_consumed" is null or "messages"."credits_consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"estimated_pages" integer,
	"parsed_tokens" integer,
	"created_by" text NOT NULL,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_status_check" CHECK ("sources"."status" in ('created', 'indexed')),
	CONSTRAINT "sources_estimated_pages_check" CHECK ("sources"."estimated_pages" is null or "sources"."estimated_pages" > 0),
	CONSTRAINT "sources_parsed_tokens_check" CHECK ("sources"."parsed_tokens" is null or "sources"."parsed_tokens" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spend_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"scope" text DEFAULT 'team' NOT NULL,
	"actor_user_id" text,
	"soft_cap_usd" numeric(12, 4),
	"hard_cap_usd" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_limits_soft_cap_check" CHECK ("spend_limits"."soft_cap_usd" is null or "spend_limits"."soft_cap_usd" >= 0),
	CONSTRAINT "spend_limits_hard_cap_check" CHECK ("spend_limits"."hard_cap_usd" is null or "spend_limits"."hard_cap_usd" >= 0),
	CONSTRAINT "spend_limits_hard_gte_soft_check" CHECK ("spend_limits"."soft_cap_usd" is null or "spend_limits"."hard_cap_usd" is null or "spend_limits"."hard_cap_usd" >= "spend_limits"."soft_cap_usd")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"plan_family" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_team_id_uq" UNIQUE("team_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_ledgers" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text,
	"actor_user_id" text,
	"feature" text NOT NULL,
	"event_type" text NOT NULL,
	"unit_type" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reference_id" text,
	"idempotency_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledgers_event_type_check" CHECK ("usage_ledgers"."event_type" in ('grant', 'reserve', 'consume', 'release', 'refund', 'expire', 'adjust')),
	CONSTRAINT "usage_ledgers_unit_type_check" CHECK ("usage_ledgers"."unit_type" in ('credit', 'page'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'workspace_admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_team_workspace_created_idx" ON "messages" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_team_workspace_created_idx" ON "sources" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spend_limits_team_scope_user_uq" ON "spend_limits" USING btree ("team_id","scope",coalesce("actor_user_id", ''));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_team_workspace_created_idx" ON "threads" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_ledgers_team_created_idx" ON "usage_ledgers" USING btree ("team_id","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_ledgers_team_workspace_created_idx" ON "usage_ledgers" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_ledgers_team_idempotency_uq" ON "usage_ledgers" USING btree ("team_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_org_slug_uq" ON "workspaces" USING btree ("organization_id","slug");
