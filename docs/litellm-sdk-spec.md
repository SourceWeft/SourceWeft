# Internal LiteLLM TS SDK Specification (Frozen)

## 1) Purpose

Define the internal TypeScript SDK used by app services to call LiteLLM.
This SDK is mandatory for all model interactions.

Status:

- Design only
- No implementation in this step

---

## 2) Goals

- Provide one stable interface for `chat`, `embeddings`, and `rerank`
- Hide provider and gateway complexity from business modules
- Normalize cross-provider output differences
- Enforce consistency for streaming, structured output, and tool calling

Non-goals:

- No provider-specific SDK usage in app modules
- No direct OpenAI/Anthropic wiring in `apps/*`

---

## 3) Package Structure

```txt
packages/litellm-sdk/
  src/
    client.ts
    config.ts
    types.ts
    endpoints/
      chat.ts
      embeddings.ts
      rerank.ts
    transport/
      http.ts
      sse.ts
    normalize/
      messages.ts
      usage.ts
      errors.ts
    compat/
      tool-choice.ts
      structured-output.ts
    middleware/
      tracing.ts
      logging.ts
      budget.ts
      circuit-breaker.ts
```

---

## 4) Public API Contract

```ts
export interface LiteLLMSDK {
  chat: {
    complete(
      input: ChatCompleteInput,
      opts?: RequestOptions,
    ): Promise<ChatCompleteResult>;
    stream(
      input: ChatStreamInput,
      opts?: RequestOptions,
    ): AsyncIterable<ChatStreamEvent>;
  };
  embeddings: {
    embed(input: EmbedInput, opts?: RequestOptions): Promise<EmbedResult>;
    embedBatch(
      input: EmbedBatchInput,
      opts?: RequestOptions,
    ): Promise<EmbedBatchResult>;
  };
  rerank: {
    rank(input: RerankInput, opts?: RequestOptions): Promise<RerankResult>;
  };
}
```

Alias-only rule in app usage:

- `chat-default`
- `embed-default`
- `rerank-default`
- `video-default`
- `tts-default`
- `asr-default`

Note: `video-default` / `tts-default` / `asr-default` are reserved aliases. In current environments they can be intentionally left empty and treated as not configured.

---

## 5) Core Types (Minimal)

```ts
export type ModelAlias =
  | "chat-default"
  | "embed-default"
  | "rerank-default"
  | "video-default"
  | "tts-default"
  | "asr-default";

export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  traceId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UnifiedError {
  code:
    | "TIMEOUT"
    | "RATE_LIMIT"
    | "AUTH"
    | "BAD_REQUEST"
    | "UPSTREAM"
    | "UNKNOWN";
  message: string;
  retryable: boolean;
  statusCode?: number;
  provider?: string;
  requestId?: string;
}
```

---

## 6) Streaming Event Model

```ts
export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string; argsJson: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "reasoning"; content: string }
  | { type: "provider_fields"; data: Record<string, unknown> }
  | { type: "done"; finishReason?: string }
  | { type: "error"; error: UnifiedError };
```

Requirements:

- Preserve usage frames even when token delta is empty.
- Preserve provider-specific metadata as explicit events.
- Ensure stream terminates with exactly one `done` or one `error`.

---

## 7) Compatibility Rules

### Tool choice

- Normalize `tool_choice: "any"` to `"required"` where provider compatibility requires it.

### Structured output

- Support `json_schema`, `json_mode`, and function-calling style.
- For strict JSON schema mode, enforce `additionalProperties: false` recursively.

### Message normalization

- Normalize provider reasoning payload to a unified field.
- Normalize provider-specific grounding/extra fields to `provider_fields`.
- Normalize tool call arguments into valid JSON object representation.

---

## 8) Transport and Retry Policy

- Default timeout: 30s for chat, 20s for embeddings/rerank
- Retry only retryable failures: timeout, 429, transient 5xx
- Backoff: exponential with jitter
- Respect per-request idempotency where supported

Do not retry:

- schema validation errors
- auth failures
- explicit content-policy hard failures

---

## 9) Middleware Pipeline

Execution sequence:

1. tracing metadata injection
2. request logging
3. budget enforcement
4. transport request
5. retry/backoff policy
6. response normalization
7. result emission

Each middleware must be side-effect safe and independently testable.

---

## 10) Observability Requirements

Attach these fields to every request:

- `trace_id`
- `workspace_id`
- `thread_id` (if chat)
- `model_alias`
- `feature` tag

Minimum metrics:

- latency (p50/p95/p99)
- request count and error rate
- token usage per alias
- retry count and fallback count

---

## 11) Security Requirements

- SDK never stores provider keys in runtime logs
- redact headers and auth payloads in all error/log outputs
- enforce allowed base URL list for LiteLLM endpoint
- reject unknown model aliases at compile-time or startup validation

---

## 12) Test Plan

### Unit

- message normalization
- tool-choice compatibility
- structured output schema handling
- error classification and retry decisions

### Integration

- chat complete/stream via LiteLLM
- embeddings and rerank happy path
- stream usage-only frame handling
- provider-specific metadata passthrough

### Contract

- ensure app-facing types are backward compatible
- ensure alias-only enforcement

---

## 13) Acceptance Criteria

- App modules can perform chat/embed/rerank with no provider-specific code
- Streaming consistently emits token/usage/done semantics
- Compatibility layer prevents known cross-provider tool/schema failures
- Provider swap requires only LiteLLM config change, no app code change

This specification is frozen for implementation kickoff.
