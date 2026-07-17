# Legacy Compat Breaking Changes

This document lists intentional breaking changes from the legacy compatibility cleanup and hardening work. Clients, operators, and integrators should review this before upgrading.

## Stream request tool keys

Legacy keys in `tools` are **rejected with HTTP 400** (they are no longer silently ignored).

| Legacy key | Replacement |
|------------|-------------|
| `tools.webSearchEnabled` | `tools.web_search.enabled` |
| `tools.artifact` | `tools.generate_image` (tool selection object) |

Canonical validation lives in `packages/contracts/src/content.ts` (`threadToolsRequestSchema`). Tests: `packages/contracts/tests/stream-request.test.ts`.

## Message metadata tool options

Turn preparation reads tool selections from **`metadata.options.tools` only**.

- New user messages persist `metadata.options = { version: 1, tools: ... }`.
- Legacy `metadata.tools` on older messages is **not** read during edit, regenerate, or refresh.
- Edit/regenerate on unmigrated rows may lose prior tool selections (web access, skills, image tool config).

### Pre-deploy metadata check (production)

Run on the target database before or immediately after deploy:

```sql
SELECT COUNT(*) AS candidates
FROM messages
WHERE metadata ? 'tools'
  AND NOT metadata ? 'options';
```

**Local dev check (2026-07-18):** `candidates = 0`. No backfill required on the local database.

If `candidates > 0`, apply a one-time backfill before users edit or regenerate those messages:

```sql
UPDATE messages
SET metadata = jsonb_set(
  metadata,
  '{options}',
  jsonb_build_object('version', 1, 'tools', metadata->'tools')
)
WHERE metadata ? 'tools'
  AND NOT metadata ? 'options';
```

Recommended: run the `COUNT` in a transaction, preview a few rows, then run `UPDATE` during a maintenance window. Back up or snapshot first.

## Slash command skill auto-selection

Slash commands no longer auto-inject skills into `skillIds` on the backend.

- Web clients should send explicit `tools.skillIds` and/or `tools.invokedSkillIds` from command discovery.
- Raw API clients that send only `command` without skill selection may see different behavior than before.

Video and image artifact entry points are skill-scoped (`/video`, `/image-generate`, etc.), not hidden tool slash commands.

## Stream model settings shape

Thread stream requests prefer top-level execution fields over nested `modelSettings`:

| Legacy | Replacement |
|--------|-------------|
| `modelSettings.imageProfileAlias` | `image.profileAlias` |
| `modelSettings.visionProfileAlias` | `vision.profileAlias` |

`modelSettings` may still parse for backward compatibility on the backend route, but web clients no longer send it. Prefer explicit `image` / `vision` / `llm` execution objects.

## Capability manifest input

Authoring manifests with legacy top-level `contributes` input is rejected at parse time. Use top-level contribution arrays (`skills`, `tools`, `connectors`, etc.) in `sourceweft.capability.json`. See `packages/capability-contracts`.

## Selectable invocation IDs

Legacy `builtin_tool.*` selectable IDs and `legacyIds` registry aliases were removed. Use capability IDs from command discovery:

```
cap:<capabilityId>:<contributionId>
```

## Skill runtime config keys

Skill runtime config merges into `defaultConfig.config` keyed by `workspaceSkillId` or `selectionId` (for example `builtin:ppt-deck`).

Legacy paths that may stop applying:

- `skillRuntimeConfig` keyed by skill slug/name only
- Nested `defaultConfig.runtime.config` (flattened to `defaultConfig.config`)

## Tool executor slash metadata

Internal artifact executors (`generate_image`, `generate_video_presentation`) no longer expose tool-level slash command metadata. Slash entry is skill-only where applicable.

## Related docs

- [legacy-compat-pr-split.md](./legacy-compat-pr-split.md) — recommended PR boundaries for this branch
