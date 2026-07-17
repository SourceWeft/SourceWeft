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
- Edit/regenerate on legacy rows may lose prior tool selections (web access, skills, image tool config).
- The web client shows an informational toast when editing or regenerating a message that still has legacy tool metadata.

**Historical data policy:** no production backfill is planned. Users can re-select tools in the composer when editing old messages.

### Pre-deploy metadata check (optional)

Run on the target database if you want visibility into legacy rows:

```sql
SELECT COUNT(*) AS candidates
FROM messages
WHERE metadata ? 'tools'
  AND NOT metadata ? 'options';
```

**Local dev check (2026-07-18):** `candidates = 0`.

If `candidates > 0` and you choose to backfill anyway:

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

## External API migration checklist

Use this when upgrading custom clients or integrations:

1. Replace `tools.webSearchEnabled` with `tools.web_search.enabled` and `tools.web_fetch.enabled` (or omit and rely on defaults).
2. Replace `tools.artifact` with a `tools.generate_image` selection object when image generation is intended.
3. Send explicit `tools.skillIds` (max **5** per turn) and optional `tools.invokedSkillIds` (max **5**). Do not rely on slash commands to auto-inject skills.
4. Prefer top-level `llm`, `image`, and `vision` execution objects instead of nested stream `modelSettings`.
5. Use capability invocation IDs (`cap:<capabilityId>:<contributionId>`) instead of `builtin_tool.*` aliases.
6. Expect HTTP **400** with schema guidance when legacy keys are present; failures are intentional.

Contract tests: `packages/contracts/tests/stream-request.test.ts`.

## Skill selection limits

`tools.skillIds` and `tools.invokedSkillIds` are capped at **5** items in `packages/contracts`. The web client enforces the same limit in the composer and shows a toast when a sixth skill is selected.

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

- [legacy-compat-pr-split.md](./legacy-compat-pr-split.md) — merge record for this work on `main`
