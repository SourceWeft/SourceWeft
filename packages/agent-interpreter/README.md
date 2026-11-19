# @sourceweft/agent-interpreter

SourceWeft's backend-only Deep Agents interpreter integration. The package wraps
LangChain's QuickJS middleware with SourceWeft-owned capability boundaries,
budgets, concurrency control, stable errors, and metadata-only events.

## Security boundary

- JavaScript/TypeScript executes in QuickJS WASM, without host `process`,
  `require`, network APIs, a shell, or dynamic subagent dispatch.
- PTC is a static read-only allowlist: `search_sources`, `ls`, `read_file`,
  `glob`, and `grep`.
- Filesystem PTC accepts only `/kb` and `/files`; `/skills`, traversal,
  writes, execution, MCP, connector, and sandbox tools are not bridged.
- The package enforces per-eval and per-turn budgets, process and turn
  concurrency limits, queue and PTC timeouts, code-size limits, memory/stack
  limits, and model-visible result truncation.
- Events contain IDs, counters, durations, tool names, and stable error codes;
  they never contain source code, queries, paths, or result bodies.

## How long one evaluation can run

The execution timeout (`executionTimeoutMs`, 3 s by default) limits the time
the evaluated code itself runs. Time spent waiting for a bridged call does not
count against it, apart from the small cost of the runtime checking for the
result about once a millisecond (`@langchain/quickjs` 0.6.2 and later; before
that it was a wall-clock limit for the whole evaluation).

The wait is bounded separately: each bridged call ends after `ptcCallTimeoutMs`
(5 s), and one evaluation may make `maxPtcCallsPerEval` calls (8). With the
defaults one evaluation therefore lasts at most about 3 s + 8 × 5 s = 43 s, and
it holds one of the `maxConcurrentEvals` slots for that time. The backend's
general tool timeout (120 s for a tool that declares none) applies on top.

The backend feature flag is `SOURCEWEFT_AGENT_INTERPRETER_ENABLED` and defaults
to `false`. See `apps/backend/.env.example` for the bounded tuning variables.
