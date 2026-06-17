# routes

Purpose of this directory:

- Define API route handlers grouped by endpoint domain.
- Keep `main.ts` focused on wiring and request lifecycle.

## Route → Module Mapping

| Route file | Primary module | Notes |
|---|---|---|
| `auth-meta.ts` | `auth` | OAuth provider metadata (public endpoint) |
| `billing.ts` | `billing` | Checkout sessions, webhooks, subscription queries |
| `dashboard.ts` | `workspace` | Dashboard workspace listing |
| `health.ts` | — | Readiness / liveness check |
| `jobs.ts` | — (shared) | Job polling (source parse, sync, etc.) |
| `desktop-auth.ts` | `auth` | Desktop auth rendezvous endpoints |
| `workspace.ts` | `workspace` | Workspace CRUD |
| `llm-observability.ts` | `llm-observability` | LLM span / trace / generation queries |
| `connectors-oauth.ts` | `connectors` | OAuth callback + state init |
| `connectors-webhooks.ts` | `connectors` | Third-party webhook receivers |
| `content/agent-confirmations.ts` | `agent-confirmations` | Human-in-the-loop tool approval |
| `content/artifacts.ts` | `artifacts` | Artifact metadata, source JSON, assets |
| `content/byok.ts` | `byok` | Bring-Your-Own-Key credential / model management |
| `content/connectors.ts` | `connectors` | Connector lifecycle + action management |
| `content/mcp.ts` | `mcp` | MCP tool install, run, approval |
| `content/model-gateway.ts` | `model-gateway` (package) | Model gateway profile / route queries |
| `content/skills.ts` | `skills` | Skill listing, enablement, validation |
| `content/sources.ts` | `sources` | Source ingestion, parsing, retrieval |
| `content/threads.ts` | `threads` | Thread + message CRUD, chat runs |
| `content/working-files.ts` | `working-files` | Agent working file lifecycle |

## Internal Modules (no direct API routes)

These modules provide services consumed by other modules and are **not** directly exposed via HTTP:

| Module | Consumed by |
|---|---|
| `blog` | `sync-notion-blog.ts` (script); web app reads blog directly from Postgres |
| `citations` | `threads` — citation storage and retrieval |
| `content` | Shared kernel — types, errors, billing port, queue helpers |
| `invocations` | `threads` — agent invocation runtime, pipelines, policies |
| `mail` | `billing`, `ops` — email notification delivery |
| `onboarding` | `auth` — first sign-in organization provisioning |
| `ops` | `billing`, `threads` — operational alerts |

## Conventions

- Route handlers delegate to module services — never contain business logic.
- Request validation uses Zod schemas from `@sourceweft/contracts`.
- Auth / workspace context is extracted in middleware, not in routes.
- New routes are added under `content/` by default; only expose a top-level route when the endpoint needs a unique path prefix or middleware stack.
