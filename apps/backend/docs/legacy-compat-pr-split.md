# Legacy Compat Merge Record

This document records how the legacy compatibility cleanup landed on `main`. It replaces the earlier PR-split planning note now that the work is merged.

## Merge status (2026-07-18)

All compat-critical work is on `main`:

| Area | Commits / notes |
|------|-----------------|
| Contracts + API hard cut | `4c6d8de` |
| Backend turn path + metadata | `4c6d8de`, `b86749b` |
| Video presentation packages | `4c6d8de` |
| Web client alignment | `4c6d8de`, `d4dd875`, `dd06be7` |
| Manifest sync tests | `4c6d8de` |
| Follow-up hardening | `d4dd875`, `b86749b`, `dd06be7` |

Independent follow-ups (not part of the compat contract) may continue on separate commits, for example model-gateway provider additions.

## Historical metadata

Legacy `metadata.tools` without `metadata.options` is no longer read during edit, regenerate, or refresh. **No backfill is planned.** Users editing very old messages may need to re-select tools in the composer.

## Review boundaries (historical)

The original split guidance grouped changes into:

1. Contracts and API hardening
2. Backend turn path and metadata
3. Video presentation package rename and worker
4. Web client alignment
5. Manifest sync tests
6. Model gateway refactor (independent)
7. Sources hub / artifact preview refactor (independent)

That split was used for review planning. Production delivery uses the merged commits above.

## Related docs

- [legacy-compat-breaking-changes.md](./legacy-compat-breaking-changes.md)
