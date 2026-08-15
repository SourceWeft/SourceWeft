# @sourceweft/agent-interpreter

SourceWeft's backend-only Deep Agents interpreter integration. The package wraps
LangChain's QuickJS middleware with SourceWeft-owned capability boundaries,
budgets, concurrency control, stable errors, and metadata-only events.

## Security boundary

- JavaScript/TypeScript executes in QuickJS WASM, without host `process`,
  `require`, network APIs, a shell, or dynamic subagent dispatch.
- PTC is a static read-only allowlist: `search_sources`, `ls`, `read_file`,
  `glob`, and `grep`.
- Filesystem PTC accepts only `/kb` and `/workfiles`; `/skills`, traversal,
  writes, execution, MCP, connector, and sandbox tools are not bridged.
- The package enforces per-eval and per-turn budgets, process and turn
  concurrency limits, queue and PTC timeouts, code-size limits, memory/stack
  limits, and model-visible result truncation.
- Events contain IDs, counters, durations, tool names, and stable error codes;
  they never contain source code, queries, paths, or result bodies.

The backend feature flag is `SOURCEWEFT_AGENT_INTERPRETER_ENABLED` and defaults
to `false`. See `apps/backend/.env.example` for the bounded tuning variables.
