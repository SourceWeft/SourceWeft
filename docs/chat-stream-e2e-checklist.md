# Chat Stream E2E Regression Checklist

## Goal

Validate chat streaming behavior end to end for `send`, `refresh`, and `edit`, with real-time tool lifecycle visibility and persisted tool metadata.

## Preconditions

- Backend API is running.
- Web app is running.
- Test user can access a workspace with at least one indexed source.
- Browser devtools is open to inspect `POST /v1/workspaces/:workspaceId/threads/:id/stream`.

## Flow 1: Send

1. Open a thread with at least one selected source.
2. Send a new prompt.
3. Verify SSE emits `start` and `text-start` before response text appears.
4. Verify tool events stream in lifecycle order for each tool call id:
   - `tool-call-start`
   - zero or more `tool-call-event`
   - `tool-call-result` (or `tool-call-error`)
   - `tool-call-end`
5. Verify the UI shows tool state transitions (`running` -> `completed` or `error`) and keeps tool output visible.
6. Verify stream completes with `text-end`, `assistant-message`, and `finish`.

## Flow 2: Refresh

1. In the latest assistant message, click Refresh.
2. Verify the new assistant branch streams with the same event lifecycle as send.
3. Verify branch selector can switch between old and refreshed assistant versions.
4. Verify each assistant branch remains linked to the correct user version.

## Flow 3: Edit

1. Edit the latest user prompt and resubmit.
2. Verify a new user branch and new assistant branch are created.
3. Verify stream tool events render on the new assistant branch while streaming.
4. Verify switching branches keeps user and assistant versions aligned.

## Tool Error Path

1. Trigger a retrieval/tool failure in a non-production environment (for example, temporary invalid retrieval config).
2. Send a prompt that invokes retrieval.
3. Verify stream emits `tool-call-error` and then `tool-call-end` with `status: error`.
4. Verify UI marks the tool call as error and shows error text.
5. Verify no tool remains stuck in `running` state after stream termination.

## Persistence Checks

1. Reload the thread page.
2. Verify assistant message metadata rehydrates tool calls with:
   - `id`
   - `tool`
   - `input`
   - `output`
   - `status`
   - `latencyMs`
   - `error`
3. Verify retrieval observability includes `attributes.retrievalCalls` summary on gateway operation events.

## Pass Criteria

- All three flows (`send`, `refresh`, `edit`) pass without UI desync.
- Tool lifecycle is consistent per `toolCallId` from stream to persisted metadata.
- Error path surfaces clear UI feedback and exits cleanly.
