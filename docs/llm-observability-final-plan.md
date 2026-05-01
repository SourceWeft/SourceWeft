# SourceWeft LLM Observability Final Plan

## 1. Purpose

SourceWeft will implement an internal LangSmith-like observability system for LLM, agent, tool, retrieval, and model-gateway execution.

This system is the primary observability and audit source for model execution inside SourceWeft. It is not an integration with LangSmith, Langfuse, or another external SaaS. External exporters can be added later, but the canonical data plane lives in SourceWeft.

The system should be named:

```txt
SourceWeft LLM Observability
```

It should not be scoped as a small `model-gateway audit` feature. Model gateway is one collection point; the full system also covers agent runs, tools, retrieval, source indexing, cost, permissions, payload policies, and admin workflows.

## 2. Goals And Non-Goals

Goals:

- Replace the core LangSmith-style observability workflow inside SourceWeft.
- Record every model call as a generation.
- Record every user request or background job as a trace.
- Represent agent runs, tools, retrieval, vector search, and model calls as a parent-child span tree.
- Allow workspace admins to inspect observability data for their workspace.
- Allow organization owners/admins to inspect observability data across their organization.
- Protect prompt, completion, tool output, and retrieval payloads with policy, redaction, retention, and access logging.
- Record provider logical input/output for all providers.
- Gradually support provider wire-level raw request/response capture where adapters allow it.
- Leave room for feedback, datasets, evaluations, and prompt/version comparisons later.

Non-goals for the MVP:

- Do not require all providers to support true wire-level raw HTTP request/response capture on day one.
- Do not build a complete evaluation platform in the first release.
- Do not build prompt registry/versioning in the first release.
- Do not store every streaming chunk in the first release.
- Do not depend on external LangSmith/Langfuse services as the primary source of truth.

## 3. Architecture Overview

High-level shape:

```txt
apps/backend
  shared/llm-observability
    trace-context
    writer
    payload-policy
    redaction
    permissions
    serializers
    metrics

  modules/content
    thread trace integration
    retrieval span integration
    agent/tool span integration
    source indexing trace integration

  api/routes
    llm observability APIs

packages/model-gateway
  endpoints
    chat
    embeddings
    rerank

  observe
    event types
    sink

  adapters
    SDK adapters
    direct transport adapters
    raw capture mode
```

Runtime flow:

```txt
Client
  -> Backend Thread/Job
    -> SourceWeft LLM Trace
      -> Agent / Retrieval / Tool Spans
        -> packages/model-gateway
          -> Generation Capture
            -> Provider SDK or Direct Transport
```

Key boundaries:

- `apps/backend/shared/llm-observability` owns persistence, policies, permissions, and serialization.
- `packages/model-gateway` owns automatic generation capture for model calls.
- Content/thread/retrieval/agent modules own trace context propagation and business spans.
- Admin APIs and UI expose the observability model under workspace/team permissions.

## 4. Observability Data Layers

The system must distinguish canonical/logical model data from provider wire-level raw data.

### 4.1 Canonical Logical Input And Output

This is required for all providers in the MVP.

Chat input:

```ts
{
  provider,
  providerModel,
  modelAlias,
  messages,
  tools,
  toolChoice,
  temperature,
  topP,
  maxTokens,
  responseFormat,
  structuredOutput,
  extraBody,
  metadata,
}
```

Chat output:

```ts
{
  assistantContent,
  reasoning,
  toolCalls,
  finishReason,
  usage,
  providerFields,
  model,
  provider,
  providerModel,
  routeDecision,
}
```

Embeddings input:

```ts
{
  provider,
  providerModel,
  inputTextPreviewOrHash,
  batchCount,
  dimensions,
  encodingFormat,
  inputType,
}
```

Embeddings output:

```ts
{
  embeddingCount,
  dimensions,
  usage,
  provider,
  providerModel,
  routeDecision,
}
```

Rerank input:

```ts
{
  provider,
  providerModel,
  query,
  documentsPreviewOrHash,
  documentCount,
  topN,
  returnDocuments,
}
```

Rerank output:

```ts
{
  results,
  scores,
  usage,
  provider,
  providerModel,
  routeDecision,
}
```

### 4.2 Provider Wire Raw Data

This is an enhanced capability and is not guaranteed for all providers in the MVP.

Provider raw fields:

```ts
providerRequestJson
providerResponseJson
providerRequestHeadersJson
providerResponseHeadersJson
providerStatusCode
providerRequestId
rawCaptureMode
rawCaptureError
```

`rawCaptureMode` values:

```ts
"none"
"normalized"
"sdk_metadata"
"reconstructed"
"provider_wire"
```

Meanings:

- `none`: no raw capture is available.
- `normalized`: only SourceWeft canonical input/output is available.
- `sdk_metadata`: metadata was captured from LangChain/provider SDK response objects.
- `reconstructed`: SourceWeft reconstructed provider-shaped request/response payloads, but they are not guaranteed to equal the exact HTTP body.
- `provider_wire`: SourceWeft captured the actual HTTP request/response via direct transport or proxy.

The UI must display `rawCaptureMode` anywhere provider raw data is shown.

## 5. Database Model

Keep the existing `model_gateway_events` table for legacy metrics/event compatibility. It should not be the primary LangSmith-like observability model.

### 5.1 `llm_traces`

Represents one complete user request or background job.

Fields:

```ts
id
traceId
teamId
workspaceId
userId
threadId
messageId
sessionId
name
feature
status
startedAt
endedAt
latencyMs
metadataJson
createdAt
```

Typical trace names:

```txt
thread.stream
thread.title
source.index
agent.run
source.reindex
```

### 5.2 `llm_spans`

Represents a step inside a trace.

Fields:

```ts
id
traceId
spanId
parentSpanId
teamId
workspaceId
userId
threadId
messageId
name
kind
operation
status
startedAt
endedAt
latencyMs
inputJson
outputJson
metadataJson
errorCode
errorMessage
createdAt
```

Span kinds:

```ts
"agent"
"tool"
"retrieval"
"vector_search"
"bm25"
"rerank"
"embedding"
"generation"
"system"
"thinking"
"http"
```

### 5.3 `llm_generations`

Represents one model call.

Fields:

```ts
id
traceId
spanId
parentSpanId
teamId
workspaceId
userId
threadId
messageId

operation
modelAlias
provider
providerModel
executionMode
keySource
routeStrategy
routeDecisionJson
modelParametersJson

inputJson
outputJson
outputText
finishReason
reasoningText
providerFieldsJson

usageJson
inputTokens
outputTokens
totalTokens
providerCostUsd

rawCaptureMode
providerRequestJson
providerResponseJson
providerRequestHeadersJson
providerResponseHeadersJson
providerStatusCode
providerRequestId
rawCaptureError

status
errorCode
errorMessage
startedAt
endedAt
latencyMs
metadataJson
createdAt
```

Operations to cover:

```txt
chat.complete
chat.stream
chat.title
embeddings.embed
embeddings.embedBatch
rerank.rank
```

### 5.4 `llm_feedback_scores`

Reserved for feedback and evaluations.

Fields:

```ts
id
traceId
spanId
generationId
teamId
workspaceId
name
value
comment
source
createdBy
createdAt
```

### 5.5 `llm_audit_access_logs`

Records access to sensitive payloads.

Fields:

```ts
id
teamId
workspaceId
actorUserId
targetType
targetId
action
metadataJson
createdAt
```

Action examples:

```txt
llm_trace.payload.viewed
llm_generation.input.viewed
llm_generation.output.viewed
llm_tool.input.viewed
llm_tool.output.viewed
```

The existing `team_audit_logs` table can be reused if actions are standardized, but a dedicated table keeps sensitive payload access auditing explicit.

## 6. Trace Tree Design

Chat request target tree:

```txt
trace: thread.stream
  span: prepare_thread_turn
  span: retrieval.initial
    generation: embeddings.embed
    span: vector_search
    generation: rerank.rank
  span: agent_run
    generation: chat.stream
    span: tool:search_sources
      span: retrieval
        generation: embeddings.embed
        span: vector_search
        generation: rerank.rank
    span: tool:read_file
    span: tool:grep
    span: thinking:verify_citations
  span: finalize_thread_turn
  generation: chat.title
```

Source indexing target tree:

```txt
trace: source.index
  span: fetch_source_object
  span: parse_document
  span: chunk_document
  generation: embeddings.embedBatch
  span: persist_chunks
```

Title generation should usually be a generation under the originating thread trace:

```txt
trace: thread.stream
  generation: chat.title
```

If title generation is asynchronous, it can use its own trace:

```txt
trace: thread.title
  generation: chat.complete
```

## 7. Collection Strategy

### 7.1 Model Gateway Captures Generations

`packages/model-gateway` endpoint layer must automatically capture generations for:

```txt
chat.complete
chat.stream
embeddings.embed
embeddings.embedBatch
rerank.rank
```

This must be done in endpoint/bridge code, not scattered through business modules.

Capture fields:

```ts
canonical input
canonical output
usage
finishReason
reasoning
providerFields
routeDecision
provider
providerModel
executionMode
latency
error
rawCaptureMode
```

Streaming behavior:

- Create generation start when the stream begins.
- Aggregate assistant output, reasoning, usage, and provider fields while streaming.
- Write generation end when the stream completes.
- Write generation error on failure.
- Do not store every chunk in the MVP.

### 7.2 Content And Agent Layers Capture Traces And Spans

Add a trace context type:

```ts
type TraceContext = {
  traceId: string;
  rootSpanId?: string;
  parentSpanId?: string;
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  feature?: string;
};
```

Trace context should flow through:

```txt
thread stream entry
  -> prepareThreadTurn
  -> retrieval service
  -> invokeDeepAgentTurn
  -> runToolRetrieval
  -> finalizeThreadTurn
  -> generateChatTitle
```

### 7.3 Tool Trace Is A First-Class Span

Existing `ToolCallTrace` data should be upgraded to `llm_spans.kind = "tool"`.

Tool lifecycle mapping:

```txt
on_tool_start -> start tool span
on_tool_event -> update/append metadata
on_tool_end   -> end tool span status=ok
on_tool_error -> end tool span status=error
```

Tool span example:

```ts
{
  kind: "tool",
  name: "tool:search_sources",
  operation: "tool.call",
  traceId,
  spanId: toolCallId,
  parentSpanId: agentRunSpanId,
  status: "ok",
  inputJson: { query },
  outputJson: { hitCount, chunkIds, sourceIds },
  latencyMs,
  metadataJson: {
    toolName: "search_sources",
    sequence,
    source: "langgraph",
  },
}
```

`search_sources` internal retrieval should be a child span:

```txt
span: tool:search_sources
  span: retrieval
    generation: embeddings.embed
    span: vector_search
    generation: rerank.rank
```

### 7.4 Retrieval Trace

Retrieval spans should cover:

```txt
query
sourceIds
embedding profile
embedding generation
BM25 latency/result count
vector search latency/result count
rerank generation
final hit count
citations
```

Retrieval payload defaults:

- Save query.
- Save source IDs and chunk IDs.
- Save chunk content only as preview/hash unless policy allows full payload.
- Save citations and counts.

### 7.5 LangChain Callback Handler As Optional Enhancement

Current code already captures many LangGraph stream events manually. Later, implement a SourceWeft LangChain callback handler to more closely match LangSmith behavior:

```txt
on_chat_model_start
on_llm_end
on_llm_error
on_tool_start
on_tool_end
on_tool_error
on_retriever_start
on_retriever_end
on_chain_start
on_chain_end
```

## 8. Provider Raw Capture Strategy

MVP commitment:

```txt
All providers have canonical logical input/output coverage.
```

MVP non-commitment:

```txt
All providers have wire-level raw HTTP request/response coverage.
```

Reason: many providers currently go through LangChain SDKs, and SDK internals do not reliably expose exact HTTP request/response bodies.

Provider handling:

- SDK provider: `rawCaptureMode = "sdk_metadata"` or `"reconstructed"`.
- Direct fetch provider: `rawCaptureMode = "provider_wire"`.
- Future direct transport provider: `rawCaptureMode = "provider_wire"`.

Direct transport migration priority:

1. OpenRouter chat.
2. OpenAI-compatible chat.
3. DeepInfra chat.
4. OpenAI-compatible embeddings.
5. DeepInfra embeddings.
6. Anthropic chat.
7. Gemini chat.
8. Azure OpenAI chat/embeddings.

## 9. Payload Policy

Add workspace/team-level policy fields:

```ts
auditPayloadMode: "metadata_only" | "preview" | "full";
auditRetentionDays: number;
auditFullPayloadRetentionDays: number;
```

Recommended defaults:

```ts
auditPayloadMode: "preview";
auditRetentionDays: 90;
auditFullPayloadRetentionDays: 30;
```

Modes:

- `metadata_only`: save only metadata, usage, cost, latency, error, model, provider, and route.
- `preview`: save truncated preview, hash, length, and structural metadata.
- `full`: save full payload subject to redaction, truncation, and max size limits.

Never save:

```txt
API key
BYOK raw key
Authorization
Cookie
Session token
Password
Secret
```

Every payload must pass through:

```txt
redaction
truncation
max byte limit
field denylist
```

Embeddings policy:

- Do not save vectors.
- Save text preview/hash, count, dimensions, usage, and latency.

Retrieval/tool policy:

- Do not save full source chunks by default.
- Save source ID, chunk ID, hit count, preview, and hash.

## 10. Permission Model

Recommended access model:

```txt
workspace_admin:
  can view traces/spans/generations/events for that workspace
  can view payload if audit policy allows it

organization owner/admin:
  can view all workspaces in the organization
  can manage audit policy and retention

billing_admin:
  can view usage/cost/metrics only
  cannot view prompt/output/tool payload

editor/viewer:
  no default access to LLM Observability

internal support:
  break-glass read-only access with strict audit logging
```

Rules:

- Workspace admins cannot cross workspace boundaries.
- Organization owners/admins can inspect all workspaces in the organization.
- Billing admins are metrics-only.
- Payload permission and payload capture policy are separate checks.
- Every prompt/output/tool payload view must create an audit access log.

## 11. API Design

Workspace-level APIs:

```txt
GET /v1/workspaces/:workspaceId/llm/traces
GET /v1/workspaces/:workspaceId/llm/traces/:traceId
GET /v1/workspaces/:workspaceId/llm/spans/:spanId
GET /v1/workspaces/:workspaceId/llm/generations
GET /v1/workspaces/:workspaceId/llm/generations/:generationId
GET /v1/workspaces/:workspaceId/llm/events
GET /v1/workspaces/:workspaceId/llm/metrics
POST /v1/workspaces/:workspaceId/llm/traces/:traceId/scores
```

Team-level APIs:

```txt
GET /v1/teams/:teamId/llm/traces
GET /v1/teams/:teamId/llm/generations
GET /v1/teams/:teamId/llm/metrics
```

Common query parameters:

```txt
from
workspaceId
userId
threadId
messageId
feature
operation
provider
modelAlias
status
limit
cursor
```

Response behavior:

- List APIs return summaries by default.
- Detail APIs return the span tree.
- Payload fields are returned only when permission and policy allow it.
- Hidden payloads should return a structured redaction marker:

```ts
{
  redacted: true,
  reason: "insufficient_permission" | "payload_policy" | "retention_expired",
}
```

## 12. UI Design

MVP UI should provide internal admin observability.

Trace list columns:

```txt
time
feature
operation
status
model
provider
latency
tokens
cost
user
thread/message
rawCaptureMode
```

Trace detail:

- Left side: span tree.
- Right side: selected node details.
- Node types: trace, span, generation, tool, retrieval, error.

Generation detail tabs:

```txt
Input
Output
Provider Raw
Usage/Cost
Metadata
Error
```

Provider Raw tab must display `rawCaptureMode`.

Tool detail tabs:

```txt
Input
Output
Metadata
Error
```

Metrics dashboard:

```txt
request count
error rate
p95 latency
tokens
cost
provider/model breakdown
```

Chat integration:

- Store or expose `traceId` on chat messages.
- Allow admins to navigate from a chat message to trace detail.

## 13. Implementation Phases

### Phase 1: Observability Infrastructure

Tasks:

- Add `llm_traces`.
- Add `llm_spans`.
- Add `llm_generations`.
- Add `llm_feedback_scores`.
- Add `llm_audit_access_logs` or standardize usage of `team_audit_logs`.
- Add `shared/llm-observability` module.
- Implement writer API.
- Implement redaction/truncation.
- Implement payload policy.
- Keep `model_gateway_events` working.

Acceptance criteria:

- Traces, spans, and generations can be created.
- Success and error paths are recorded.
- Payload redaction has tests.
- Large payloads are truncated.
- Existing runtime behavior is unchanged.

### Phase 2: Model Gateway Generation Capture

Tasks:

- Instrument `chat.complete`.
- Instrument `chat.stream`.
- Instrument `embeddings.embed`.
- Instrument `embeddings.embedBatch`.
- Instrument `rerank.rank`.
- Add `rawCaptureMode`.
- Aggregate streaming final output.
- Record generation errors.
- Capture usage, cost, and latency.

Acceptance criteria:

- Main chat writes generations.
- Title generation writes generations.
- Embeddings write generations.
- Rerank success/failure writes generations.
- SDK providers have canonical input/output.
- Direct fetch providers have `provider_wire` raw capture.

### Phase 3: Trace Tree Propagation

Tasks:

- Create root trace in thread stream entry.
- Write prepare/finalize spans.
- Write retrieval spans.
- Write vector/BM25 spans.
- Write agent run span.
- Write tool start/end/error spans.
- Attach `search_sources` retrieval under the tool span.
- Store thinking steps as metadata initially.
- Store `traceId` in message metadata.

Acceptance criteria:

- A chat request shows a complete span tree.
- Tool input/output/status/error/latency are queryable.
- Retrieval/embedding/rerank hierarchy is correct.
- `messageId` can find the trace.
- `traceId` can locate the thread/message.

### Phase 4: Admin APIs And Permissions

Tasks:

- Implement workspace admin checker.
- Implement organization owner/admin checker.
- Implement billing admin metrics-only access.
- Implement trace list/detail APIs.
- Implement generation list/detail APIs.
- Implement span detail API.
- Implement metrics API.
- Log payload view access.

Acceptance criteria:

- Workspace admins can only see their workspace.
- Organization admins can see all organization workspaces.
- Editors/viewers cannot access full observability.
- Billing admins cannot view payload.
- Prompt/output/tool output access is audited.

### Phase 5: Admin UI

Tasks:

- Trace list.
- Trace detail tree.
- Generation detail.
- Tool detail.
- Metrics dashboard.
- Chat message to trace navigation.

Acceptance criteria:

- Admins can locate failed requests.
- Admins can inspect model input/output.
- Admins can inspect tool traces.
- Admins can inspect retrieval traces.
- Admins can inspect usage/cost.
- UI displays `rawCaptureMode` clearly.

### Phase 6: Provider Wire Raw Enhancement

Tasks:

- OpenRouter direct chat transport.
- OpenAI-compatible direct chat transport.
- DeepInfra direct chat transport.
- OpenAI-compatible embeddings direct transport.
- Anthropic direct transport.
- Gemini direct transport.
- Azure direct transport.
- Stream raw capture.

Acceptance criteria:

- Core providers use `rawCaptureMode = "provider_wire"`.
- Provider request/response bodies are auditable.
- Headers are redacted.
- Streaming aggregation does not regress latency or behavior.

### Phase 7: Feedback, Eval, Dataset

Later phase for deeper LangSmith-like features.

Tasks:

- Trace/generation feedback.
- Dataset examples.
- Eval runs.
- Auto scoring.
- Prompt/model regression comparison.
- Prompt versioning.

This phase is not part of the MVP.

## 14. MVP Scope

MVP includes:

- `llm_traces`.
- `llm_spans`.
- `llm_generations`.
- Model-gateway automatic generation capture.
- Chat stream/complete input/output/usage/cost/error.
- Embeddings/rerank generations.
- Tool calls as spans.
- Retrieval trace.
- Workspace admin query API.
- Payload policy.
- Redaction/truncation.
- `rawCaptureMode`.
- Simple trace list/detail UI.

MVP excludes:

- Full provider direct raw capture.
- Eval/dataset.
- Prompt versioning.
- Stream chunk replay.
- OpenTelemetry exporter.
- LangSmith/Langfuse exporter.

## 15. Test Plan

Unit tests:

- Redaction.
- Truncation.
- Payload mode.
- Trace writer.
- Span writer.
- Generation writer.
- Stream aggregation.
- Usage normalization.
- Tool span start/end/error.
- Permission checker.

Integration tests:

- `chat.complete` writes a generation.
- `chat.stream` writes a generation.
- `embeddings.embed` writes a generation and does not save vectors.
- `rerank.rank` writes success and failure generations.
- `search_sources` writes a tool span.
- Retrieval under a tool is attached as a child span.
- Workspace admin can query traces.
- Editor/viewer cannot query full observability.
- Payload access writes an audit log.

Regression tests:

- SSE behavior is unchanged.
- Billing behavior is unchanged.
- Message persistence is unchanged.
- BYOK raw keys are never stored.
- Large payloads do not fail user requests.
- Existing `model_gateway_events` behavior is not broken.

## 16. Risks And Controls

Data volume risk:

- Default to preview mode.
- Full payload retention defaults to 30 days.
- Enforce payload size limits.
- Move large payloads to object storage later if necessary.

Privacy risk:

- Do not save full retrieval chunks by default.
- Do not save embedding vectors.
- Apply redaction denylist.
- Log payload access.
- Restrict access to workspace/org admins.

SDK raw capture risk:

- Guarantee canonical input/output instead of wire raw.
- Display `rawCaptureMode` everywhere raw data is shown.
- Gradually migrate core providers to direct transport.

Latency risk:

- Allow observability writer to be fire-and-forget.
- Observability write failure must not fail the user request.
- Use a queue if synchronous writes become expensive.
- Aggregate stream output instead of saving every chunk in the MVP.

Dual-model inconsistency risk:

- New tables are the primary observability model.
- `model_gateway_events` remains legacy metrics/event compatibility.
- Move new APIs and UI to the new model.

## 17. Review Decision

Recommendation: approve this direction and implement Phases 1 through 5 as the first delivery target.

Required principles:

- Name the system `SourceWeft LLM Observability`.
- Use `llm_traces`, `llm_spans`, and `llm_generations` as the primary model.
- Keep `model_gateway_events` only for legacy compatibility and metrics.
- Capture model calls automatically in the model-gateway endpoint layer.
- Treat tool trace as a first-class span.
- Include retrieval trace in the span tree.
- Restrict full observability access to workspace admins and organization owner/admins.
- Audit prompt/output/tool payload access.
- Guarantee provider logical input/output for all providers.
- Use `rawCaptureMode` for provider wire raw support status.

Final acceptance criterion:

```txt
A workspace admin can open SourceWeft Observability, find a chat request, see the complete trace tree, inspect model generations, inspect tool calls, inspect retrieval, view usage/cost/errors, and access payloads only when permissions, payload policy, redaction, and retention allow it.
```
