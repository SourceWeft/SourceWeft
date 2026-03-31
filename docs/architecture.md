# SourceWeft Architecture (V1)

## 1. Purpose

This document defines the final architecture for the current SourceWeft phase and serves as the implementation reference.

Design principles for this version:

- Keep it simple and executable
- Avoid over-engineering
- Support `Web`, `Browser Extension`, and `Desktop (Tauri)`
- Exclude `Mobile (RN)` for now
- Do not introduce a separate `infra/` directory in this phase

---

## 2. Key Decisions

1. Use a single monorepo with `pnpm workspace + turbo`.
2. Keep backend in one app (`apps/backend`) with three runtime entry points:
   - `api`
   - `worker`
   - `scheduler`
3. Use one shared UI package for current platforms: `ui-web`.
4. Share cross-platform logic via `contracts + sdk + domain`.
5. Standardize long-running work as async jobs queued by API.
6. Use `BullMQ + Redis` as the queue skeleton (no in-memory queue).
7. Extension target for V1 is Chromium-first (`Chrome + Edge`, MV3) via WXT.

---

## 3. Target Directory Layout

```txt
SourceWeft/
  apps/
    web/                          # Next.js app
    extension/                    # Browser extension (WXT)
    desktop/                      # Tauri app (frontend + src-tauri)
    backend/                      # Backend app with 3 process entry points
      src/
        api/
          main.ts                 # HTTP API entry
          routes/
          middleware/
        worker/
          main.ts                 # Async job consumer entry
          processors/
        scheduler/
          main.ts                 # Timed job dispatcher entry (enqueue only)
          schedules/
        modules/                  # Business modules (auth/document/job/...)
        shared/                   # Shared backend utilities (db/queue/logger/config)
      package.json
    docs/                         # Optional product docs app

  packages/
    contracts/                    # Shared API + job contracts (zod/types)
    sdk/                          # Unified frontend API client layer
    domain/                       # Platform-agnostic business logic
    ui/                           # Shared web UI package (`@sourceweft/ui-web` during migration)
    config-eslint/
    config-typescript/
    config-tailwind/
    testing/

  docs/
    architecture.md               # This document

  turbo.json
  pnpm-workspace.yaml
  package.json
```

---

## 4. Responsibilities by Layer

### 4.1 Apps

- `apps/web`: primary product experience and web routes.
- `apps/extension`: browser-side capture and extension UX (WXT runtime).
- `apps/desktop`: Tauri desktop shell; business UI reuses `ui-web`.
- `apps/backend/src/api`: auth, validation, synchronous reads, enqueue jobs.
- `apps/backend/src/worker`: executes long-running and background tasks.
- `apps/backend/src/scheduler`: creates periodic jobs only.

### 4.2 Packages

- `packages/contracts`: request/response schemas and job payload contracts.
- `packages/sdk`: shared request client with auth/retry/error handling.
- `packages/domain`: reusable business rules without platform APIs.
- `packages/ui` (`@sourceweft/ui-web`): reusable components for web/extension/desktop frontend.

---

## 5. Dependency Rules (Hard Constraints)

1. `apps/*` must not import from other `apps/*`.
2. `apps/*` can import from `packages/*` only.
3. Frontend API calls must go through `packages/sdk`.
4. `packages/domain` must not depend on `window`, `document`, `chrome.*`, or `tauri` APIs.
5. `packages/contracts` should contain contracts/types only (no side effects).
6. `api` should not execute heavy jobs directly; it only enqueues and returns status.

---

## 6. Backend Runtime Model

Backend code lives in one app, but runs as three separate processes:

- `api`: handles HTTP requests
- `worker`: consumes job queue and executes work
- `scheduler`: triggers scheduled jobs

Queue backend in this phase: `BullMQ + Redis`.

Benefits:

- One codebase, low complexity
- Runtime isolation between API and heavy tasks
- Independent scaling for worker process

---

## 7. Async Job Model

### 7.1 Job States

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

### 7.2 Minimal Tables

- `jobs`
- `job_events`
- `schedules`

### 7.3 Required Capabilities

- Idempotency key
- Retry with backoff
- Timeout and cancellation
- Failure visibility and observability
- Queue engine: BullMQ (backed by Redis)

---

## 8. Minimal API Contract (V1)

- `GET /api/v1/health`
- `POST /api/v1/jobs`
- `GET /api/v1/jobs/:id`
- `POST /api/v1/jobs/:id/cancel`
- `GET /api/v1/jobs/:id/events`

All DTOs should be defined in `packages/contracts`.

Skeleton note:

- `POST /api/v1/jobs/:id/cancel` is intentionally a placeholder in this phase and returns `{ implemented: false }`.
- `GET /api/v1/jobs/:id/events` currently returns an empty list placeholder.

---

## 9. UI Strategy (Current Phase)

Keep only `ui-web` in this phase (currently implemented in `packages/ui` as package `@sourceweft/ui-web`).

Consumers:

- `apps/web`
- `apps/extension` (popup/options UI)
- `apps/desktop` frontend

Notes:

- `shadcn` and `ai-elements` belong to `ui-web`
- AI chat stack layering (`ai-elements`, `@ai-sdk/react`, `LangChain/LangGraph`) is documented in `docs/ai-runtime-integration-guide.md`
- `ui-mobile` is intentionally out of scope for now

---

## 10. Extension Compatibility (WXT)

- Primary target: `Chrome + Edge` (Manifest V3).
- `browser: "chrome"` is used as default local development target.
- Firefox support is intentionally out of scope in V1 to keep delivery simple.

---

## 11. Environment Management

- Keep one `.env.example` per app (`apps/backend`, `apps/web`, `apps/extension`, `apps/desktop`).
- Do not keep concrete env values at repository root.
- Use `docs/env.md` as the root-level env index and naming guide.
- Keep secrets backend-only; frontend apps should use public-safe variables only.

---

## 12. Implementation Order

1. Create backend skeleton (`api`, `worker`, `scheduler`).
2. Create `contracts`, `sdk`, and `domain` packages.
3. Route frontend calls through `sdk`.
4. Consolidate shared web UI into `ui-web`.
5. Connect web/extension/desktop end-to-end with backend.

---

## 13. Explicit Non-Goals

- No microservice split in this phase
- No standalone `infra/` directory
- No RN/mobile app setup yet
- No `ui-core` abstraction yet

---

## 14. Success Criteria

- Web/extension/desktop all use `sdk` to talk to backend
- At least one full flow works: `API enqueue -> Worker execute -> API status query`
- Scheduler can enqueue periodic jobs reliably
- Directory boundaries are clear and enforceable in CI/linting
