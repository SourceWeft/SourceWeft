# Capability Binding

SourceWeft capabilities declare what they contribute through top-level manifest fields (`skills`, `tools`, `connectors`, and so on). The capability contracts layer normalizes those fields into a single post-parse `contributes` object that runtime and backend code consume.

## Manifest shape

Author manifests in `sourceweft.capability.json` using top-level contribution arrays:

```json
{
  "schemaVersion": 1,
  "id": "sourceweft/ppt-deck",
  "kind": "skill",
  "skills": [{ "id": "ppt-deck", "options": [] }]
}
```

Legacy `contributes.*` input is no longer accepted. After parsing, every manifest exposes normalized contributions at `manifest.contributes`.

## Runtime discovery

`@sourceweft/capability-runtime` discovers packages, parses manifests, and builds command/tool registries from `getCapabilityContributions(manifest)`, which reads only the normalized `contributes` object.

## Skill option binding

Skill options declare a `target.path` that maps user selections into per-turn config:

- Tool-scoped options use paths like `config.aspectRatio` on the target tool selection.
- Skill-scoped options use paths like `config.stylePreset` and are serialized in `tools.skillRuntimeConfig`.

During turn preparation the backend merges `skillRuntimeConfig` entries keyed by `workspaceSkillId` or `selectionId` (for example `builtin:ppt-deck`) into `EnabledSkillDescriptor.defaultConfig.config`. Agent prompts read those values through the runtime context builder.

## Invocation binding

Selectable invocations for capability tools use stable capability IDs:

```
cap:<capabilityId>:<contributionId>
```

Example: `cap:sourceweft/generate-image:generate_image`

Legacy `builtin_tool.*` selectable IDs and `legacyIds` aliases were removed. Clients should send capability IDs from command discovery.

## Package sync tests

Builtin packages that export a typed manifest constant should keep `sourceweft.capability.json` in sync with that export. See `packages/builtin-connector-notion/tests/manifest.test.ts` and sibling package tests for the pattern.

## Execution

This document covers how manifest fields bind. For what actually runs a capability —
the skill / tool / deliverable-host split, and which one a new capability belongs in —
see [capability-execution-model.md](./capability-execution-model.md).
