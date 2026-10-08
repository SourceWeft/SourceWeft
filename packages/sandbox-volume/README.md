# @sourceweft/sandbox-volume

Persistent `/workspace` for agent sandboxes. The authoritative copy lives outside any sandbox
(Postgres index + immutable packs in the object store); the sandbox holds a disposable copy that
an in-sandbox helper keeps in sync and restores on demand.

| Directory      | Contents                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol` | Wire formats shared with the helper: manifest object layout, tail marker, path rules, the manifest validator                            |
| `src/service`  | `VolumeService`: write-once slots, WAL application, restore plans, history/rollback, pack repair                                        |
| `src/hooks`    | The five integration points used by `builtin-tool-sandbox`: `attach`, `wrapCommand`, `parseResult`, `checkpoint`, `onContainerReplaced` |
| `src/store`    | S3-compatible object store adapter (pre-signed URLs only reach the sandbox)                                                             |
| `helper/`      | Rust helper (`swvol`: change detection, chunked sync, restore; `swlazy`: FUSE on-demand lower)                                          |
| `image/`       | Image layer: `install-swvol.sh` + `swvol-init` (root boot step)                                                                         |
| `vectors/`     | Protocol test vectors shared by the TypeScript and Rust test-suites                                                                     |

Tables are in `@sourceweft/db` (`sandbox_volume*`). Apply migrations 0060, 0061 and 0062
in order; 0061 upgrades existing volumes conservatively instead of inventing confirmations.

## Current integration status

The deployment flag remains disabled by default. `full` currently uses the hardened eager
restore path; `shadow` creates a separate observation namespace per attachment and never
restores or updates the primary volume. The Rust `swlazy mount-volume` command consumes the
same chunked, compressed, hash-verified format as the sync helper and has Linux FUSE/overlay
acceptance coverage. Provider bootstrap has not yet wired that mount into the production
`full` lifecycle.

Host confirmation requires an active attachment's committed sequence. Database row locks,
attachment/epoch checks and an immutable commit receipt prevent competing hosts from accepting
each other's progress. Each command gets a separate flush report. A failed or uncertain flush
preserves its command result and must never cause an automatic command replay. Missing helper
state and changed boot identity require explicit recovery; they do not prove the local files
are disposable. A provider-confirmed missing instance can be recovered into a new instance.

Persistent sandbox cancellation quarantines the attachment when the provider cannot prove
command termination. Automatic TTL deletion is deferred even after a successful checkpoint
until background writers can be drained. Operator recovery/cleanup remains necessary for
these retained instances. A verified session deletion response alone is insufficient: the
Cloudflare probe found that a completed command's background child can survive it.

The scheduler applies bounded batches of background WAL. Storage operations have deadlines;
per-volume transaction quotas cover logical bytes, files, entries and registered objects.
`service.maintenance.collect(volumeId)` defaults to a dry run and a 24-hour grace period.
Explicit deletion protects current files, all retained history, inline manifests and all
active/quarantined attachments. Unknown bucket objects and deleted-thread outbox cleanup are
not yet covered. No bucket-wide lifecycle expiration substitutes for this reference check.

Remaining production qualification includes protected provider bootstrap and daemon lifecycle,
independent slot/URL renewal and repair, safe draining and cancellation, scale/soak testing,
and the shadow observation period. A local test pass is not a production release approval.

## Tests

- `pnpm test` — protocol, hooks, shell-wrapper and storage deadline tests. Database cases are
  explicitly skipped unless `SANDBOX_VOLUME_TEST_DATABASE_URL` names a disposable PostgreSQL.
- `SANDBOX_VOLUME_TEST_DATABASE_URL=postgresql://... pnpm test` — adds real transaction,
  independent-process concurrency, migration, quota and GC tests in generated private schemas.
- `helper/test-linux.sh --with-fuse` — uses the pinned Linux builder, real inotify, a small
  ENOSPC filesystem and an explicitly privileged disposable FUSE/overlay test container.
  It requires locked dependencies to be fetched first; it fails rather than downloading or
  changing toolchains during its offline tests. Omitting `--with-fuse` does not verify mounting.
- `SANDBOX_VOLUME_E2E=1 pnpm test:e2e` — real S3 and provider acceptance, requiring the test
  database URL, explicit S3 configuration and Cloudflare bridge settings. An optional
  `SANDBOX_VOLUME_E2E_ENV_FILE` may name an authorized configuration file; backend `.env` is
  never read implicitly. All objects use generated `_swvol-e2e/<run>/` prefixes, and all database
  rows use fresh schemas and test threads. Existing application threads are never selected.
  The sandbox suite also requires current helper binaries from `pnpm helper:build`.

`.github/workflows/sandbox-volume.yml` runs isolated PostgreSQL and explicit Linux filesystem
tests. Real cloud acceptance uses separate credentials and is not represented by skipped tests.

Status: see GitHub issue #228.

## Helper 0.2.0 recovery contract

All three Rust crates and `helper/VERSION` are versioned together. A deployment must install
and verify `swvol 0.2.0`; an older cached executable must fail the version check instead of
being used with these hooks. Immutable manifest objects remain protocol v1. The local pending
journal is now explicitly `SWVPEND2` and records its original manifest key. Ordinary recovery
rejects an unknown journal version or an epoch mismatch and retains its bytes. Only a
host-authorized explicit rebase may archive that journal in `.sourceweft/recovery` and rebuild
from local content. Uncontrolled upgrades must not delete, ignore, or reinterpret an old
pending journal.

Eager restore requires a quiescent target without existing user content. It returns
`RESTORE_TARGET_NOT_EMPTY` before altering the old attachment identity when content is present;
it does not overlay a restored tree onto a live or dirty workspace. Fresh-instance recovery
continues to work. Files are built in a private staging directory using descriptor-relative
`openat` operations with `O_NOFOLLOW`, exclusive creation, and inode checks on reopened files.
Symlink target strings are preserved, but parent symlinks are never traversed. Top-level entries
are published with Linux `renameat2(RENAME_NOREPLACE)`. A competing entry is retained and causes
failure. Publishing multiple top-level entries is not a single filesystem transaction: a
conflict can leave staged and published restore content for explicit recovery, and no ready
identity is written. Failed downloads retain the staging tree rather than deleting user data.
Provider bootstrap must keep workloads stopped until the final identity is published.

## FUSE lifecycle qualification remains blocked

`helper/test-fuse-lifecycle.sh` runs the fixed Linux/fuser P0 counterexample separately from
mount/data acceptance. On Linux 7.0.12-linuxkit with fuser 0.15.1, a supervisor retained the
original `/dev/fuse` descriptor, then killed a child after a real read had been dequeued but
before its reply. Restarting with `Session::from_fd` did not complete that read, and a fresh
read failed. The replacement session also starts with `initialized=false`, while the existing
kernel connection does not issue another INIT. Reader subprocesses keep `FD_CLOEXEC`; only the
server inherits the preserved descriptor. Cleanup verifies this experiment's mountpoint,
filesystem source and device number before aborting only its own connection.

A successful counterexample test records `transparent_recovery=false`. It is evidence that
retaining a descriptor alone is insufficient, not a production lifecycle acceptance pass.
There is no automatic switch to eager, remount of a different tree, or replay of user commands.

The proposed next design keeps a stable unprivileged FUSE dispatch process that owns INIT,
inode/open-handle state, and outstanding request/reply IDs. Bounded network and decompression
workers may restart; the dispatch process can resubmit idempotent reads for the same immutable
chunk and return exactly one validated reply. This only provides worker recovery. If the
dispatch process itself crashes, the attachment must fail explicitly, preserve the writable
upper layer, and use a separately reviewed recovery procedure. It does not promise transparent
recovery of the entire FUSE daemon. This architecture is a proposal and has not been implemented.
