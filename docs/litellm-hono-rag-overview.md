# LiteLLM-First Architecture Overview (Frozen)

Layering note:

- This document defines the abstract AI runtime/data architecture.
- Account topology (individual/team), billing, and governance are intentionally treated as separate concerns.
- A product/account model can be composed on top of this runtime without changing the core stack.

## 1) Scope

This document is the review-friendly architecture overview for the current phase.
It focuses on system boundaries and deployment decisions.

Out of scope in this document:

- User/account hierarchy and role policy details
- Team/organization billing model
- Enterprise governance controls (SSO/SCIM/domain policy)

Companion detailed spec:

- `docs/litellm-sdk-spec.md`
- `docs/ai-runtime-integration-guide.md`
- `docs/team-first-final-architecture.md` (separate product/account architecture)

---

## 2) Final Stack

- API: `Hono` (REST + SSE)
- Orchestration: `LangGraph.js`
- LLM primitives: `LangChain.js`
- Gateway: `LiteLLM` (Day 1)
- Storage: `AWS S3` only
- Database: `PostgreSQL + pgvector + tsvector`
- Queue: `BullMQ + Redis`
- Parsing: `Docling` (worker side)
- Layout rule: root `docker/` directory, no `infra/`

---

## 3) Architecture Topology

```txt
Client/Web
  -> Hono API
     -> LangGraph runtime
     -> internal LiteLLM SDK
     -> LiteLLM Proxy
     -> PostgreSQL (metadata + vectors + lexical)
     -> Redis/BullMQ (jobs)

Worker
  -> fetch from S3
  -> parse via Docling
  -> chunk + embedding via LiteLLM
  -> persist to PostgreSQL
```

Hard constraints:

- App code cannot call provider SDKs directly.
- All model calls go through `packages/litellm-sdk`.
- File upload is S3 presigned flow; API does not proxy raw binary streams.

---

## 4) Repository Layout

```txt
VelaMind/
  apps/
    api/
    worker/

  packages/
    contracts/
    db/
    graph/
    rag/
    litellm-sdk/

  docker/
    docker-compose.yml
    litellm/config.yaml
    postgres/init.sql
    postgres/extensions.sql
    api/Dockerfile
    worker/Dockerfile

  docs/
    architecture.md
    litellm-hono-rag-overview.md
    litellm-sdk-spec.md
```

---

## 5) API Surface (V1)

### Ingestion

- `POST /v1/uploads/presign`
- `POST /v1/sources`
- `POST /v1/sources/:id/index`
- `GET /v1/sources/:id/status`

### Chat

- `POST /v1/threads`
- `POST /v1/threads/:id/stream`
- `POST /v1/threads/:id/resume`
- `GET /v1/threads/:id/messages`

---

## 6) Data Model (Minimum)

- `workspaces`
- `sources`
- `documents`
- `chunks`
- `threads`
- `messages`
- `citations`
- `jobs_audit`

Required indexes:

- `HNSW` on `chunks.embedding`
- `GIN` on `chunks.search_tsv`
- btree `(workspace_id, document_id)`
- btree `messages(thread_id, created_at)`

---

## 7) RAG Flow (NotebookLM-style)

### Ingestion flow

1. Register source metadata
2. Pull object from S3
3. Parse by Docling
4. Normalize and chunk text
5. Generate embeddings (`embed-default`)
6. Persist docs/chunks/index fields

### Retrieval flow

1. Query rewrite
2. Dense retrieval (`pgvector`)
3. Lexical retrieval (`tsvector`)
4. RRF fusion
5. Rerank (`rerank-default`)
6. Context packing
7. Generation (`chat-default`)
8. Citation guard

Output rule:

- Answers must be evidence-backed with citation IDs.
- If evidence is missing, return explicit insufficiency.

---

## 8) LiteLLM Alias Policy

Allowed model aliases in app code:

- `chat-default`
- `embed-default`
- `rerank-default`

Provider changes are only allowed in:

- `docker/litellm/config.yaml`

---

## 9) S3 Policy (No MinIO)

- S3 only, no MinIO fallback
- Private bucket + Block Public Access
- SSE-KMS enabled
- Short-lived presigned URLs
- Least-privilege IAM

Recommended prefixes:

- `raw/{workspaceId}/{sourceId}/...`
- `parsed/{workspaceId}/{sourceId}/...`
- `artifacts/{workspaceId}/{threadId}/...`

---

## 10) Security and Governance

- Workspace-level auth on source/thread operations
- Centralized secret management for LiteLLM/provider keys
- Log model aliases and trace IDs, never secret-bearing payloads
- Audit job lifecycle (`jobs_audit`) and failure causes

---

## 11) Delivery Phases

1. Base platform: Hono, LiteLLM, Postgres, Redis, S3 wiring
2. Ingestion: S3 -> Docling -> chunk -> embedding -> DB
3. Chat: LangGraph + streaming + citations
4. Quality: RRF tuning + rerank + eval set
5. Production hardening: observability, budgets, alerting

This is design-only. Implementation starts in a separate phase.
