# LiteLLM-First TS Architecture (Design Freeze)

Layering note:

- This document is the abstract runtime architecture (AI stack, data flow, service boundaries).
- Product/account concerns (individual/team hierarchy, billing policy, enterprise governance) are intentionally out of scope here.
- Those concerns are documented separately and can be composed with this runtime design.

Split review docs:

- `docs/litellm-hono-rag-overview.md`
- `docs/litellm-sdk-spec.md`
- `docs/ai-runtime-integration-guide.md`

This file remains as the consolidated freeze record.

## 1) Purpose

This document defines the final architecture for a SurfSense/NotebookLM-like project,
with a pure TypeScript stack, self-hosted data plane, and LiteLLM from Day 1.

Scope boundary for this document:

- Focuses on runtime, retrieval, ingestion, and model-gateway integration
- Does not prescribe a specific account model (individual/team/enterprise)

Status:

- Design only
- No implementation started
- This document is the source of truth for the next execution phase

---

## 2) Final Decisions

1. API framework: `Hono`
2. Agent/workflow runtime: `LangGraph.js`
3. LLM integration primitives: `LangChain.js`
4. LLM gateway: `LiteLLM` from Day 1 (no direct provider calls in app code)
5. Object storage: `AWS S3` only (no MinIO)
6. RAG storage: `PostgreSQL + pgvector + tsvector`
7. Async execution: `BullMQ + Redis`
8. Document parsing: `Docling` (worker-side)
9. Repository layout: `docker/` at root (no `infra/` directory)
10. Build a custom internal TS package: `packages/litellm-sdk`

---

## 3) Target Repository Layout

```txt
SourceWeft/
  apps/
    api/                           # Hono API (REST + SSE)
    worker/                        # BullMQ workers (ingestion/reindex)

  packages/
    contracts/                     # zod schemas + DTO contracts
    db/                            # schema + migrations + query helpers
    graph/                         # LangGraph nodes/state/edges
    rag/                           # retrieval + RRF + citation guard
    litellm-sdk/                   # internal TS SDK for LiteLLM

  docker/
    docker-compose.yml
    litellm/
      config.yaml
    postgres/
      init.sql
      extensions.sql
    api/
      Dockerfile
    worker/
      Dockerfile

  docs/
    architecture.md
    litellm-hono-rag-architecture.md   # this document
```

---

## 4) Runtime Architecture

```txt
Client/Web
  -> apps/api (Hono)
     -> packages/graph (LangGraph flow)
     -> packages/litellm-sdk -> LiteLLM Proxy
     -> PostgreSQL (metadata + vectors + lexical index)
     -> Redis/BullMQ (enqueue background jobs)

apps/worker
  -> pull S3 object
  -> Docling parse
  -> chunk + embed via LiteLLM
  -> write chunks + indexes to PostgreSQL
```

Key constraints:

- App code never hardcodes provider-specific APIs (OpenAI/Anthropic SDK direct usage is disallowed).
- All model access goes through `packages/litellm-sdk`.
- Upload path is S3 presigned URL; API does not proxy raw file streams.

---

## 5) Hono API Contract (V1)

### Source ingestion

- `POST /v1/uploads/presign`
  - Returns presigned S3 upload URL and required form fields.
- `POST /v1/sources`
  - Registers uploaded object metadata (bucket, key, hash, mime, size).
- `POST /v1/sources/:id/index`
  - Enqueues parsing/chunking/embedding/indexing job.
- `GET /v1/sources/:id/status`
  - Returns ingestion status and error reason if failed.

### Chat and threads

- `POST /v1/threads`
  - Creates a chat thread within workspace/notebook scope.
- `POST /v1/threads/:id/stream`
  - SSE stream for assistant response + retrieval/citation events.
- `POST /v1/threads/:id/resume`
  - Resumes interrupted flow (human approval/tool decisions).
- `GET /v1/threads/:id/messages`
  - Returns message history with citations.

---

## 6) Database Model (PostgreSQL)

Minimum tables:

- `workspaces`
- `sources`
- `documents`
- `chunks`
- `threads`
- `messages`
- `citations`
- `jobs_audit`

### Required `chunks` columns

- `id`
- `document_id`
- `workspace_id`
- `content` (text)
- `embedding` (vector)
- `search_tsv` (tsvector)
- `metadata_json` (jsonb)
- `created_at`

### Required indexes

- `HNSW` index on `chunks.embedding`
- `GIN` index on `chunks.search_tsv`
- btree on `(workspace_id, document_id)`
- btree on `messages(thread_id, created_at)`

---

## 7) RAG Pipeline (NotebookLM-style)

### Ingestion pipeline

1. Validate source metadata
2. Fetch object from S3
3. Parse with Docling
4. Normalize text and structural metadata
5. Chunking (section-aware + overlap)
6. Embedding via LiteLLM (`embed-default`)
7. Write `documents/chunks` to PostgreSQL
8. Mark source status

### Retrieval pipeline

1. Query normalization/rewrite
2. Dense retrieval (`pgvector`)
3. Lexical retrieval (`tsvector`/BM25-like ranking)
4. RRF fusion
5. Rerank via LiteLLM (`rerank-default`)
6. Context assembly with token budget
7. Generation via LiteLLM (`chat-default`)
8. Citation guard (enforce evidence-backed answer)

### Output rules

- Every claim must map to citation IDs.
- If evidence is insufficient, return explicit insufficiency instead of guessing.

---

## 8) LiteLLM Model Alias Policy

Application only uses model aliases, never provider model IDs directly.

Mandatory aliases:

- `chat-default`
- `embed-default`
- `rerank-default`

Provider swaps must be done in `docker/litellm/config.yaml` only.

---

## 9) Custom TS SDK (`packages/litellm-sdk`)

## 9.1 Goals

- Provide one stable app-facing interface for chat/embed/rerank
- Add cross-provider normalization and compatibility handling
- Keep provider/gateway complexity out of business code

## 9.2 Public interfaces

- `chat.complete()`
- `chat.stream()`
- `embeddings.embed()`
- `embeddings.embedBatch()`
- `rerank.rank()`

## 9.3 Internal modules

```txt
packages/litellm-sdk/
  src/
    client.ts
    config.ts
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

## 9.4 Required compatibility features

- Normalize `provider_specific_fields` and `reasoning` payloads
- Preserve stream usage chunks (including empty-choice usage frames)
- Tool-choice compatibility guard (`any` to `required` when needed)
- Unified structured output behavior (`json_schema`, `json_mode`, function calling)
- Unified error model and retry classification across providers

## 9.5 Middleware chain

Execution order:

1. tracing metadata
2. request logging
3. budget check
4. call execution
5. retry/backoff handler
6. response normalization

---

## 10) S3-Only Storage Policy

Rules:

- No MinIO service in local or production design
- Private bucket only
- SSE-KMS encryption enabled
- Presigned upload/download flow
- Strict IAM least privilege

Recommended key prefixes:

- `raw/{workspaceId}/{sourceId}/...`
- `parsed/{workspaceId}/{sourceId}/...`
- `artifacts/{workspaceId}/{threadId}/...`

---

## 11) Queue and Job Policy

Queues:

- `ingest`
- `reindex`
- `cleanup`

Job requirements:

- idempotency key
- retry with backoff
- timeout and dead-letter queue
- `jobs_audit` logging

---

## 12) Security and Governance

- Workspace-level authorization on all source/thread routes
- Signed URL TTL must be short-lived
- Do not store provider secrets in app-level user tables
- Use centralized secret management for LiteLLM/provider credentials
- Log model alias, not raw secret-bearing provider payloads

---

## 13) Non-Goals (Current Phase)

- No direct provider SDK calls in app modules
- No separate `infra/` directory
- No MinIO fallback profile
- No implementation of deep autonomous mode in V1 default path

---

## 14) Execution Checklist (Design to Build Handoff)

1. Lock this document and architecture decisions
2. Create package/app skeletons exactly as section 3
3. Bootstrap `packages/litellm-sdk` interfaces and tests first
4. Wire API -> graph -> litellm-sdk minimal happy path
5. Implement ingestion worker path (S3 -> Docling -> PG)
6. Implement retrieval + RRF + rerank + citation guard
7. Add observability, budgets, and failure dashboards

Note: This checklist is for execution planning only. No coding starts in this step.

---

## 15) Out-of-Scope Concerns (Handled Elsewhere)

- Team/individual account hierarchy
- Team-level billing seats and invoicing policy
- Enterprise identity and governance (SSO/SCIM/domain capture)
- Multi-company isolation policy and deployment governance

Reference document:

- `docs/team-first-final-architecture.md`
