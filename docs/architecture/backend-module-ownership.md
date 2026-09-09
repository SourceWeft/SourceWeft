# Backend Module Ownership

This document classifies `apps/backend/src/modules` after the package-first
capability migration. The goal is to keep backend modules focused on host
orchestration while portable capability behavior moves to standalone packages.

## Ownership Classes

- **host-owned**: stays in `apps/backend` because it owns tenant state,
  persistence, secrets, billing host wiring, queue wiring, auth/session policy, or runtime
  process orchestration.
- **capability-adjacent**: may call capability packages or runtime registries,
  but still owns backend adapters, persistence, request context, permissions,
  and dependency injection.
- **package-candidate**: contains portable logic that should move to a
  `packages/*` workspace package once characterization tests pin behavior.
- **delete-after-migration**: transitional shim or hardcoded path that must be
  deleted only after `rg` proves no importers remain.

## Non-Negotiable Boundaries

- Code that imports `shared/database` or `shared/db/schema` is host-owned unless
  it is first inverted behind an explicit port.
- Code that imports `shared/queue`, `shared/secrets`, tenant permission checks,
  backend config, request/session context, or workspace membership policy is
  host-owned.
- Capability packages must not import from `apps/backend/src/shared` or
  `apps/backend/src/modules`.
- `@sourceweft/capability-runtime` must stay generic and must not import
  concrete `@sourceweft/builtin-*` packages.
- Temporary backend imports from concrete `@sourceweft/builtin-*` packages are
  compatibility shims, not the final architecture.

## Top-Level Modules

- `agent-confirmations`: `host-owned`
  - Owns confirmation orchestration across connector and MCP execution flows.
  - Keep in backend because it coordinates persisted action records,
    permissions, and user approval state.
  - Cleanup rule: it may consume generic invocation/capability descriptors, but
    must not import concrete builtin packages or branch on package names.

- `auth`: `host-owned`
  - Owns Better Auth configuration, migrations, auth callbacks, passkeys, and
    organization metadata.
  - Keep in backend because it owns session/auth provider integration and DB
    migration coupling.
  - Cleanup rule: no capability package imports should appear here.

- `billing`: `optional commercial application-service package`
  - Owns account state, plan catalog projection, ledger writes, provider
    webhooks, subscription reconciliation, and usage metering.
  - Implementation lives in `enterprise/billing`; the backend owns authentication, membership queries and edition binding. Core runs without the package.
  - Cleanup rule: pure credit math already belongs in packages such as
    `@sourceweft/credits-core`; do not move provider orchestration into
    capability packages.

- `blog`: `host-owned`
  - Owns Notion-backed public blog sync, rendering, and public storage upload.
  - Keep in backend because it is an application service, not an agent
    capability contribution.
  - Cleanup rule: no migration unless a pure renderer helper becomes broadly
    reusable outside backend.

- `connectors`: `capability-adjacent`
  - Owns connector repository state, OAuth, permissions, webhooks, sync
    orchestration, and action execution.
  - Package-candidate area: connector metadata, action schemas, pure request
    normalization, and builtin connector descriptors such as Notion.
  - Host-owned area: OAuth token exchange, encrypted credentials, DB
    repositories, webhook persistence, workspace permissions, and action run
    state.
  - Cleanup rule: replace `registerBuiltinConnectorAdapters` with a generic
    capability-backed connector bootstrap after connector contributions are
    represented in manifests.
  - Deletion receipt: Task 11 replaced connector approval error source refs
    with `connector_action`; connector capability packaging remains Task 12.

- `content`: `capability-adjacent`
  - Owns source ingestion, artifacts, skills, retrieval, thread orchestration,
    agent adapters, storage, citations, and working files.
  - Package-candidate subareas:
    - `content/agent/tools`: portable tool prompt/schema/formatting logic.
    - `content/web`: web search/fetch normalization and public URL safety,
      excluding backend config/API key wiring.
    - `content/parsers`: pure document parser contracts and local parsers.
    - `content/retrieval`: retrieval prompt formatting and pure pipeline
      contracts.
    - `content/video-presentation`: portable specs/planning helpers that do
      not require queues, storage, model gateway clients, or DB records.
    - `content/skills`: builtin skill package discovery should eventually be
      runtime-owned; repository sync remains backend-owned.
    - `content/threads/turn`: command workflow lookup should use a backend
      capability runtime adapter instead of concrete builtin fallbacks.
  - Host-owned subareas:
    - artifact repositories and persisted versions.
    - source repositories and indexing status.
    - storage buckets and upload/download keys.
    - model gateway execution, billing, trace context, queue jobs, and tenant
      permissions.
  - Cleanup rule: backend should inject these host services into package-owned
    portable logic through typed ports.

- `invocations`: `capability-adjacent`
  - Owns selectable invocation registry, resolver, policy evaluation, pipeline
    events, and deepagents handoff.
  - Package-candidate area: generic projection from capability contributions.
  - Host-owned area: execution policy, resolver state, direct runtime handoff,
    and event emission.
  - Cleanup rule: project selectable invocations from capability contribution IDs
    (`cap:<capabilityId>:<contributionId>`) only.
  - Deletion receipt: Task 11 deleted
    `apps/backend/src/modules/invocations/providers/builtin-tools.ts`; current
    projection is capability-owned in
    `apps/backend/src/modules/invocations/providers/capability-tools.ts`.
  - Legacy compatibility removed: `builtin_tool.*` selectable IDs and registry
    `legacyIds` aliases were deleted; clients must send capability IDs from
    command discovery (see `docs/architecture/capability-binding.md`).

- `llm-observability`: `host-owned`
  - Owns backend presentation and permissions for LLM observability data.
  - Keep in backend because access control and trace presentation are backend
    service concerns.
  - Cleanup rule: no concrete capability package imports should appear here.

- `mcp`: `capability-adjacent`
  - Owns workspace MCP installs, credential storage, market manifest validation,
    endpoint safety, tool run persistence, and confirmation payloads.
  - Backend-local adapter target: pure MCP manifest/tool projection moves to
    `apps/backend/src/modules/mcp/capability-bridge.ts`.
  - Host-owned area: encrypted secrets, endpoint safety policy, DB records,
    install lifecycle, confirmation persistence, and actual MCP execution.
  - Cleanup rule: do not create a new MCP package in the current plan; isolate
    projection logic inside the backend adapter first.

- `onboarding`: `host-owned`
  - Owns startup workspace/org setup and calls auth, billing, and workspace
    services.
  - Keep in backend because it coordinates application services.
  - Cleanup rule: no capability migration.

- `ops`: `host-owned`
  - Owns operational alert state and notification orchestration.
  - Keep in backend because it uses backend mail/config/store concerns.
  - Cleanup rule: no capability migration.

- `workspace`: `host-owned`
  - Owns workspace records, membership, roles, and service-level workspace
    context.
  - Keep in backend because every capability adapter consumes this context but
    must not own it.
  - Cleanup rule: expose typed context to capability adapters; do not move
    workspace state into packages.

## Current Compatibility Shims

This inventory is the source of truth for current backend imports that mention
`@sourceweft/builtin-*`. Regenerate the source list with:

```bash
rg "@sourceweft/builtin-" apps/backend/src/modules -g '*.ts'
```

Every matching backend path must appear in the table below. Valid statuses are
`keep-temporary`, `replace-before-delete`, and `delete-now`. There are no
`delete-now` entries yet because each current import still has an importer or
fallback behavior that must be replaced in a later task.

| Path | Owner package | Status | Removal prerequisite | Verification command |
| --- | --- | --- | --- | --- |
| `apps/backend/src/modules/content/agent/tools/generate-image-tool.ts` | `@sourceweft/builtin-tool-generate-image` | `replace-before-delete` | image artifact execution is registered through capability tool executors while backend keeps model gateway, storage, billing, and repository ports | `rg "generate-image-tool|createGenerateImageTool|@sourceweft/builtin-tool-generate-image" apps/backend/src/modules/content/agent/tools packages -g '*.ts'` |
| `apps/backend/src/modules/content/agent/tools/generate-pptx-tool.ts` | `@sourceweft/builtin-tool-generate-pptx` | `replace-before-delete` | PPTX artifact execution is registered through capability tool executors while backend keeps storage, repository, and renderer adapter ports | `rg "generate-pptx-tool|createGeneratePptxTool|@sourceweft/builtin-tool-generate-pptx" apps/backend/src/modules/content/agent/tools packages -g '*.ts'` |
| `apps/backend/src/modules/content/agent/tools/generate-video-presentation-tool.ts` | `@sourceweft/builtin-tool-generate-video-presentation` | `replace-before-delete` | video presentation execution is registered through capability tool executors while backend keeps queue and artifact repository ports | `rg "generate-video-presentation-tool|createGenerateVideoPresentationTool|@sourceweft/builtin-tool-generate-video-presentation" apps/backend/src/modules/content/agent/tools packages -g '*.ts'` |
| `apps/backend/src/modules/content/agent/tools/retrieval-tool.ts` | `@sourceweft/builtin-retrieval` | `replace-before-delete` | retrieval tool formatting is registered through a capability retrieval provider while backend keeps LangChain tool runtime and source search port injection | `rg "retrieval-tool|createRetrievalTool|@sourceweft/builtin-retrieval" apps/backend/src/modules/content/agent/tools packages -g '*.ts'` |
| `apps/backend/src/modules/content/retrieval/planner.ts` | `@sourceweft/builtin-retrieval` | `replace-before-delete` | pure ranking and citation helpers are consumed through retrieval capability projection while backend keeps vector provider strategy selection | `rg "retrieval/planner|planRetrievalStrategy|@sourceweft/builtin-retrieval" apps/backend/src/modules/content/retrieval packages -g '*.ts'` |
| `apps/backend/src/modules/content/retrieval/pipeline/constants.ts` | `@sourceweft/builtin-retrieval` | `replace-before-delete` | retrieval pipeline constants are resolved through package-owned retrieval stage contracts | `rg "pipeline/constants|DEFAULT_RRF_K|@sourceweft/builtin-retrieval" apps/backend/src/modules/content/retrieval packages -g '*.ts'` |
| `apps/backend/src/modules/content/retrieval/pipeline/types.ts` | `@sourceweft/builtin-retrieval` | `replace-before-delete` | retrieval stage contracts are owned by the capability package while backend keeps host state shape and trace/model fields | `rg "pipeline/types|RetrievalPipelineStage|@sourceweft/builtin-retrieval" apps/backend/src/modules/content/retrieval packages -g '*.ts'` |
| `apps/backend/src/modules/content/retrieval/pipeline/stages/assemble-context.ts` | `@sourceweft/builtin-retrieval` | `replace-before-delete` | assemble-context pure helpers are package-owned while backend stage injects repository reads | `rg "assemble-context|listDocumentChunks|@sourceweft/builtin-retrieval" apps/backend/src/modules/content/retrieval packages -g '*.ts'` |
| `apps/backend/src/modules/content/agent/filesystem-capabilities.ts` | `@sourceweft/builtin-vfs` | `keep-temporary` | agent prompt assembly consumes VFS capability records generically | `rg "filesystem-capabilities" apps/backend/src packages -g '*.ts'` |
| `apps/backend/src/modules/content/agent/mounted-fs-backend.ts` | `@sourceweft/builtin-vfs` | `keep-temporary` | backend mounts are constructed through VFS provider registry | `rg "mounted-fs-backend|MountedAgentFilesystemBackend" apps/backend/src packages -g '*.ts'` |
| `apps/backend/src/modules/content/agent/tools/web-tools.ts` | `@sourceweft/builtin-tool-web-search` | `replace-before-delete` | web search/fetch tools are registered through capability tool executors | `rg "agent/tools/web-tools|createWebTools" apps/backend/src packages -g '*.ts'` |
| `apps/backend/src/modules/content/virtual-fs/paths.ts` | `@sourceweft/builtin-vfs` | `replace-before-delete` | virtual-fs path callers import VFS package APIs directly or through a VFS provider registry | `rg "content/virtual-fs/paths|buildVirtualSource|normalizeVirtualPath|safeVirtualName" apps/backend/src packages -g '*.ts'` |
| `apps/backend/src/modules/content/virtual-fs/types.ts` | `@sourceweft/builtin-vfs` | `replace-before-delete` | virtual-fs type callers import VFS package APIs directly or through a VFS provider registry | `rg "content/virtual-fs/types|VirtualFsChunk|VirtualFsDocument|VirtualFsSource|VirtualPathTarget" apps/backend/src packages -g '*.ts'` |
| `apps/backend/src/modules/content/threads/turn/capability-command-workflows.ts` | backend runtime adapter | `replace-before-delete` | command workflows resolve from configured capability runtime roots without concrete builtin package fallback | `rg "capability-command-workflows|@sourceweft/builtin-" apps/backend/src/modules/content/threads/turn packages -g '*.ts'` |
| `apps/backend/src/modules/content/threads/turn/preparer-command-workflow.test.ts` | backend runtime adapter | `keep-temporary` | regression test is deleted or rewritten after configured runtime root discovery is mandatory | `rg "preparer-command-workflow.test|@sourceweft/builtin-" apps/backend/src/modules/content/threads/turn packages -g '*.ts'` |

## Deletion Rules

- A file can move to `delete-after-migration` only when an equivalent package or
  generic runtime path exists and focused tests cover both happy and edge cases.
- A deletion receipt must include:
  - the removed path.
  - the replacement package/runtime path.
  - a no-importer `rg` command.
  - the focused tests proving behavior preservation.
- Backward compatibility fields such as legacy request metadata may remain only
  when web/API tests prove they are still needed.
