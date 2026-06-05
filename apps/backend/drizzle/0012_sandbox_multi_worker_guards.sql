create unique index "agent_sandboxes_one_active_per_thread_uq"
  on "agent_sandboxes" (
    "provider",
    "team_id",
    "workspace_id",
    "thread_id"
  )
  where "status" in ('creating', 'ready');

create unique index "agent_sandbox_operations_active_tool_call_uq"
  on "agent_sandbox_operations" (
    "team_id",
    "workspace_id",
    "thread_id",
    "operation_type",
    "tool_call_id"
  )
  where "status" in ('running', 'succeeded') and "tool_call_id" is not null;
