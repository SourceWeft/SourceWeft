# AI Runtime Integration Guide (AI SDK + AI Elements + LangChain/LangGraph)

## 1. Purpose and Status

This guide defines the canonical layering and integration boundaries for the AI chat stack in this monorepo.

It clarifies the role of:

- `ai-elements` (UI components)
- AI SDK (`ai`, `@ai-sdk/react`) (chat interaction runtime)
- `@ai-sdk/langchain` (protocol adapter)
- `LangChain` and `LangGraph` (backend orchestration runtime)

Status:

- Architecture guide for implementation
- Compatible with current MVP behavior in this repository
- Aligned with `docs/architecture.md`, `docs/litellm-hono-rag-overview.md`, and `docs/litellm-hono-rag-architecture.md`

---

## 2. Key Positioning

Short answer:

- `LangChain/LangGraph` does **not** replace AI SDK UI/runtime concerns.
- AI SDK does **not** replace backend orchestration and retrieval concerns.
- `@ai-sdk/langchain` is the intended translation layer between both sides.

Layer ownership:

| Layer                                | Primary responsibility                                                     | Runs in                        | Must not do                                    |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| `ai-elements` (`@sourceweft/ui-web`) | Rendering message UI, tool UI, markdown, chat visuals                      | Frontend shared UI package     | Own transport, model calls, auth, or RAG logic |
| AI SDK (`ai`, `@ai-sdk/react`)       | Chat state, message lifecycle, stream consumption in UI                    | Frontend app                   | Implement retrieval/orchestration logic        |
| `@ai-sdk/langchain`                  | Convert message and stream protocol between AI SDK and LangChain/LangGraph | Server route or server runtime | Contain business/domain rules                  |
| `LangChain` / `LangGraph`            | Agent workflow, tools, retrieval orchestration, state graph                | Backend/API/worker             | Render UI or hold client view state            |

---

## 3. Repository Reality (Current State)

Current implementation in this repository:

1. `ai-elements` are in shared UI package and exported from `@sourceweft/ui-web`.
2. `@ai-sdk/react` is installed and currently used in demo pages.
3. Current backend chat route named `.../stream` is MVP JSON response (not SSE token stream yet).
4. LangChain/LangGraph are architecture decisions in docs for the main SourceWeft runtime, but not yet wired in the active backend path.

This means the repo is in a bridge phase: UI and contracts exist, runtime orchestration upgrade is planned.

---

## 4. Canonical Integration Pattern (Target)

Recommended target flow:

```txt
apps/web (useChat + ai-elements)
  -> app/api/chat (server route)
     -> toBaseMessages(...) from @ai-sdk/langchain
     -> LangGraph/LangChain runtime
     -> toUIMessageStream(...) from @ai-sdk/langchain
  -> stream back to useChat
```

Why this pattern is preferred:

- Keeps one protocol boundary in one place
- Avoids custom event translation scattered across UI components
- Preserves clean package boundaries from `docs/architecture.md`
- Makes migration from MVP to streaming incremental and low-risk

---

## 5. Complexity Control Rules

To avoid accidental architecture drift, enforce these rules:

1. Keep exactly one message translation boundary (`@ai-sdk/langchain`) in the server path.
2. Keep `ai-elements` presentation-only.
3. Keep all model/provider/workflow logic in backend runtime.
4. Keep frontend API access through `@sourceweft/sdk` unless there is a dedicated chat route designed for `useChat` streaming.
5. Do not expose provider-native payloads to UI; expose normalized message parts/events only.

---

## 6. MVP Handling Policy

### 6.1 MVP baseline (current repository)

The current MVP is valid and intentionally minimal:

- Chat write path exists via backend content APIs.
- Endpoint `POST /v1/workspaces/:workspaceId/threads/:id/stream` returns a final JSON payload.
- Billing metering is already integrated in the stream call path.
- No token-level SSE streaming yet.
- No tool-event streaming contract yet.

MVP decision for this phase:

- Keep this behavior as the release baseline.
- Do not block MVP release on full LangGraph streaming.

### 6.2 MVP done criteria

MVP is considered complete when:

1. User message persists successfully.
2. Assistant message persists successfully.
3. Billing consume entry is recorded for chat feature.
4. Team/workspace isolation rules are respected.
5. Frontend can render thread messages reliably without custom provider logic.

### 6.3 MVP+1 (adapter-based streaming upgrade)

After MVP, upgrade in one step without changing UI ownership:

1. Introduce server chat route that accepts AI SDK UI messages.
2. Convert messages with `toBaseMessages(...)`.
3. Invoke LangGraph/LangChain streaming runtime.
4. Convert stream with `toUIMessageStream(...)`.
5. Keep `ai-elements` unchanged (UI should not know LangGraph internals).

This provides streaming/tool events while preserving current frontend architecture.

---

## 7. MVP to Target Migration Plan

### Phase A: Stabilize MVP contracts

- Keep current content contracts and SDK clients as source of truth.
- Keep route naming and team/workspace checks stable.

### Phase B: Add adapter path in parallel

- Add a dedicated chat route for AI SDK-style streaming.
- Keep old JSON route for backward compatibility during transition.

### Phase C: Switch frontend chat transport

- Move production chat UI from manual request/response to `useChat` transport.
- Keep the same message rendering components in `@sourceweft/ui-web`.

### Phase D: Decommission legacy path

- Remove duplicated non-stream code path when parity is confirmed.
- Keep contract tests for message and billing invariants.

---

## 8. Package-Level Responsibilities

`apps/web`

- Own page-level UX and chat interaction state.
- Consume shared UI from `@sourceweft/ui-web`.
- Use AI SDK hooks only at app layer, not in shared component package.

`packages/ui` (`@sourceweft/ui-web`)

- Own visual and interaction components (`ai-elements`, base UI primitives).
- No direct API calls, no backend model bindings.

`apps/backend`

- Own authorization, workspace/team validation, billing hooks, and orchestration invocation.
- Keep model alias and provider details server-side.

`packages/contracts`

- Own DTO and schema contracts.
- Remain provider/runtime agnostic.

`packages/sdk`

- Own typed API client for app callers.
- Remain transport/domain focused (not UI-state focused).

---

## 9. Non-Goals

Out of scope for this guide:

- Choosing provider-specific model IDs
- Prompt engineering details
- RAG ranking formula tuning
- LangGraph node-level implementation details

Those concerns belong to runtime and model-specific design documents.

---

## 10. Acceptance Criteria for This Guide

This guide is successful when the team aligns on the following:

1. `ai-elements` = UI layer only.
2. AI SDK = frontend chat runtime only.
3. `@ai-sdk/langchain` = translation boundary.
4. LangChain/LangGraph = backend orchestration/runtime.
5. MVP can ship without full streaming, with a defined path to adapter-based streaming.
