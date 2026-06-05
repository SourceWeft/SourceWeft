create table "agent_sandboxes" (
  "id" text primary key not null,
  "provider" text not null,
  "provider_sandbox_id" text not null,
  "team_id" text not null,
  "workspace_id" text not null references "workspaces"("id") on delete cascade,
  "thread_id" text not null references "threads"("id") on delete cascade,
  "user_id" text not null,
  "status" text default 'creating' not null,
  "network_policy" text default 'default' not null,
  "metadata_json" jsonb default '{}'::jsonb not null,
  "last_used_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  constraint "agent_sandboxes_workspace_team_fk" foreign key ("workspace_id", "team_id") references "workspaces"("id", "organization_id") on delete cascade,
  constraint "agent_sandboxes_thread_workspace_team_fk" foreign key ("thread_id", "workspace_id", "team_id") references "threads"("id", "workspace_id", "team_id") on delete cascade,
  constraint "agent_sandboxes_status_check" check ("status" in ('creating', 'ready', 'expired', 'closed', 'error'))
);

create unique index "agent_sandboxes_provider_sandbox_uq"
  on "agent_sandboxes" ("provider", "provider_sandbox_id");

create index "agent_sandboxes_thread_status_idx"
  on "agent_sandboxes" ("team_id", "workspace_id", "thread_id", "status");

create index "agent_sandboxes_expires_idx"
  on "agent_sandboxes" ("status", "expires_at");

create table "agent_sandbox_operations" (
  "id" text primary key not null,
  "sandbox_id" text references "agent_sandboxes"("id") on delete set null,
  "operation_type" text not null,
  "team_id" text not null,
  "workspace_id" text not null references "workspaces"("id") on delete cascade,
  "thread_id" text not null references "threads"("id") on delete cascade,
  "message_id" text references "messages"("id") on delete set null,
  "tool_call_id" text,
  "user_id" text not null,
  "status" text not null,
  "request_json_redacted" jsonb default '{}'::jsonb not null,
  "result_json_redacted" jsonb default '{}'::jsonb not null,
  "duration_ms" integer,
  "created_at" timestamp with time zone default now() not null,
  constraint "agent_sandbox_operations_workspace_team_fk" foreign key ("workspace_id", "team_id") references "workspaces"("id", "organization_id") on delete cascade,
  constraint "agent_sandbox_operations_thread_workspace_team_fk" foreign key ("thread_id", "workspace_id", "team_id") references "threads"("id", "workspace_id", "team_id") on delete cascade,
  constraint "agent_sandbox_operations_type_check" check ("operation_type" in ('prepare', 'execute', 'collect', 'create', 'close', 'cleanup')),
  constraint "agent_sandbox_operations_status_check" check ("status" in ('proposed', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'canceled')),
  constraint "agent_sandbox_operations_duration_check" check ("duration_ms" is null or "duration_ms" >= 0)
);

create index "agent_sandbox_operations_sandbox_created_idx"
  on "agent_sandbox_operations" ("sandbox_id", "created_at" desc);

create index "agent_sandbox_operations_thread_created_idx"
  on "agent_sandbox_operations" ("team_id", "workspace_id", "thread_id", "created_at" desc);

create index "agent_sandbox_operations_tool_call_idx"
  on "agent_sandbox_operations" ("tool_call_id");
