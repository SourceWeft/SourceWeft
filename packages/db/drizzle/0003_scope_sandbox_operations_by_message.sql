DROP INDEX IF EXISTS "agent_sandbox_operations_success_tool_call_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_sandbox_operations_active_tool_call_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sandbox_operations_success_tool_call_uq"
ON "agent_sandbox_operations" USING btree (
  "team_id",
  "workspace_id",
  "thread_id",
  "message_id",
  "operation_type",
  "tool_call_id"
)
WHERE "agent_sandbox_operations"."status" = 'succeeded'
  AND "agent_sandbox_operations"."message_id" IS NOT NULL
  AND "agent_sandbox_operations"."tool_call_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sandbox_operations_active_tool_call_uq"
ON "agent_sandbox_operations" USING btree (
  "team_id",
  "workspace_id",
  "thread_id",
  "message_id",
  "operation_type",
  "tool_call_id"
)
WHERE "agent_sandbox_operations"."status" IN ('running', 'succeeded')
  AND "agent_sandbox_operations"."message_id" IS NOT NULL
  AND "agent_sandbox_operations"."tool_call_id" IS NOT NULL;
