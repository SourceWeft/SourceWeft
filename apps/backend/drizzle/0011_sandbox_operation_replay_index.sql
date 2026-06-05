create unique index "agent_sandbox_operations_success_tool_call_uq"
  on "agent_sandbox_operations" (
    "team_id",
    "workspace_id",
    "thread_id",
    "operation_type",
    "tool_call_id"
  )
  where "status" = 'succeeded' and "tool_call_id" is not null;
