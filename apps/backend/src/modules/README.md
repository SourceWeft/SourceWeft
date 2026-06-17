# modules

Domain and infrastructure modules for the backend. Each module exposes a clear
service interface via its `index.ts` barrel export.

## Domain modules

| Module | Purpose |
|---|---|
| `threads` | Thread CRUD, agent turns, SSE streaming, durable chat runs |
| `sources` | Source CRUD, parsing (PDF, audio, web, etc.), indexing, retrieval |
| `skills` | Workspace skill catalog and custom skill management |
| `artifacts` | Generated artifacts (images, slides, presentations) |
| `connectors` | External data source connectors and sync orchestration |
| `mcp` | MCP (Model Context Protocol) server management |
| `invocations` | Invocation pipeline: slash commands, tools, skills, MCP |
| `byok` | Bring Your Own Key credential management |
| `working-files` | Thread-scoped working file storage |
| `workspace` | Workspace and organization management |
| `auth` | Authentication configuration (Better Auth) |
| `blog` | Notion-powered blog sync |
| `citations` | Citation storage and retrieval |
| `agent-confirmations` | Tool approval confirmation flow |
| `onboarding` | Organization provisioning and personal team setup |

## Infrastructure modules

| Module | Purpose |
|---|---|
| `billing` | Team-scoped credits and pages metering |
| `llm-observability` | LLM call tracing and observability |
| `mail` | Provider-agnostic mail service (Plunk adapter) |
| `ops` | Alerting and operational notifications |

## Shared kernel

| Module | Purpose |
|---|---|
| `content` | Domain types, errors, job definitions, billing port, model gateway utilities |
