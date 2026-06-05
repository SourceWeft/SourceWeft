# Agent sandbox runtime

This module bridges SourceWeft working files and an isolated execution runtime.

## Mental model

- Agent-facing semantics are provider-neutral.
- Provider names such as Daytona must not appear in agent-facing prompts.
- `/work` is durable SourceWeft working-file storage.
- Sandbox `/workspace` is transient and disposable.
- `/kb` evidence is not mounted or directly copied into the sandbox.
- Prepare and collect are explicit bridge operations.

## Runtime assembly

`createSandboxRuntimeForTurn` returns no sandbox runtime unless the operator has explicitly enabled sandbox execution, selected a supported provider, configured provider credentials, and configured a default snapshot/image.

Turn assembly also returns no sandbox runtime when the current tool policy denies `execute`, because DeepAgents command execution is the sandbox entry point.

When enabled, runtime assembly provides:

- `SourceWeftDaytonaBackend` for backend-provided DeepAgents `execute`;
- `prepare_sandbox_workspace`;
- `collect_sandbox_outputs`;
- sandbox HITL interrupt configs.

## Why `execute` is backend-provided

`execute` remains the DeepAgents backend command execution path. SourceWeft does not define a duplicate custom `execute` tool. This preserves existing DeepAgents execution semantics and lets `interruptOn.execute` apply uniformly.

## Prepare bridge

`prepare_sandbox_workspace` copies explicitly selected SourceWeft `/work` files into sandbox `/workspace/input` or `/workspace/work`.

Rules:

- `/kb` is never copied or mounted directly;
- path validation rejects traversal and unsupported paths;
- file count and byte limits apply;
- operation metadata is recorded without storing full file content.

## Collect bridge

`collect_sandbox_outputs` copies selected sandbox text outputs from `/workspace/output` or `/workspace/work` back into SourceWeft `/work`.

Rules:

- V1 collect-to-work is text-only;
- binary-looking outputs are rejected;
- overwrite requires explicit tool-call intent;
- artifact collection is not exposed until artifact pipeline integration exists.

## Provider adapter boundary

`DaytonaAdapter` is the provider-specific implementation. Higher-level sandbox tools should depend on provider-neutral behavior and stable SourceWeft error codes.

Provider-specific errors should be normalized to SourceWeft sandbox errors such as:

- `SANDBOX_PROVIDER_AUTH_FAILED`
- `SANDBOX_NOT_FOUND_OR_EXPIRED`
- `SANDBOX_COMMAND_TIMEOUT`
- `SANDBOX_FILE_NOT_FOUND`
- `SANDBOX_PROVIDER_ERROR`

## Operation audit states

Sandbox operations record operation type, status, request metadata, redacted result/error data, tool call id, and duration.

Current operation types include:

- create
- prepare
- execute
- collect
- cleanup/delete

Status values should distinguish successful, failed, expired/closed, and provider-error cases according to the database schema and manager behavior.

## Idempotency and multi-worker safety

Sandbox side effects are guarded by database constraints, not process-local
locks. SourceWeft may run multiple backend workers, API processes, schedulers,
or resumed HITL tool calls concurrently.

Active sandbox uniqueness is enforced per provider/team/workspace/thread where
the sandbox status is `creating` or `ready`. `getOrCreateThreadSandbox` inserts a
SourceWeft `creating` row before calling the provider, updates it to `ready`
after provider creation succeeds, and marks it `error` if provider creation
fails. A second worker that observes a non-stale `creating` row fails safely
with `SANDBOX_CREATION_IN_PROGRESS` instead of creating another provider
sandbox.

Prepare, execute, and collect operations claim a `running` operation row before
performing side effects. A partial unique index prevents another worker from
claiming the same team/workspace/thread/operation/tool-call identity while it is
`running` or `succeeded`. Successful operations store replay-safe redacted
results and resumed calls return those results without repeating upload,
command execution, download, or `/work` writes.

Prepare and collect use the LangChain `ToolRuntime.toolCallId` as their stable
operation identity. Execute uses the sandbox execute tool-call id captured by
the HITL confirmation and carried through SourceWeft resume metadata. There is
no command-hash fallback: if sandbox execute reaches the backend without this
approved stable id, the backend fails before creating or touching a sandbox.

Cleanup uses `expired` for TTL cleanup and `closed` only for explicit close.
Provider `not found` during cleanup is treated as success because the desired
final state is already true; temporary provider/auth/network failures are
recorded as failed cleanup operations and leave the sandbox `ready` for retry.
