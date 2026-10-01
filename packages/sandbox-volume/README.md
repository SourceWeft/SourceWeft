# @sourceweft/sandbox-volume

Persistent `/workspace` for agent sandboxes. The authoritative copy lives outside any sandbox
(Postgres index + immutable packs in the object store); the sandbox holds a disposable copy that
an in-sandbox helper keeps in sync and restores on demand.

| Directory | Contents |
|---|---|
| `src/protocol` | Wire formats shared with the helper: manifest object layout, tail marker, path rules, the manifest validator |
| `src/service` | `VolumeService`: write-once slots, WAL application, restore plans, history/rollback, pack repair |
| `src/hooks` | The five integration points used by `builtin-tool-sandbox`: `attach`, `wrapCommand`, `parseResult`, `checkpoint`, `onContainerReplaced` |
| `src/store` | S3-compatible object store adapter (pre-signed URLs only reach the sandbox) |
| `helper/` | Rust helper (`swvol`: change detection, chunked sync, restore; `swlazy`: FUSE on-demand lower) |
| `image/` | Image layer: `install-swvol.sh` + `swvol-init` (root boot step) |
| `vectors/` | Protocol test vectors shared by the TypeScript and Rust test-suites |

Tables are in `@sourceweft/db` (`sandbox_volume*`).

## Tests

- `pnpm test` — unit tests (protocol, validator, vectors).
- `SANDBOX_VOLUME_E2E=1 pnpm test:e2e` — e2e against the developer's backend environment
  (`apps/backend/.env`: Postgres + bucket, and the Cloudflare dev bridge for the sandbox suite).
  Everything is written under `_swvol-e2e/<run>/` and removed afterwards. The sandbox suite needs
  `pnpm helper:build` (Docker) first.

Status: see GitHub issue #228.
