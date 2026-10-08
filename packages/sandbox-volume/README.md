# @sourceweft/sandbox-volume

Persistent `/workspace` for agent sandboxes. Confirmed versions live outside the sandbox
(Postgres index + immutable packs in the object store). A live workspace may also contain
unconfirmed local writes; it must not be discarded before a verified persistence barrier.
Asynchronous capture cannot recover those writes after permanent loss of their only disk copy.

| Directory      | Contents                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol` | Wire formats shared with the helper: manifest object layout, tail marker, path rules, the manifest validator                            |
| `src/service`  | `VolumeService`: write-once slots, WAL application, restore plans, history/rollback, pack repair                                        |
| `src/hooks`    | The five integration points used by `builtin-tool-sandbox`: `attach`, `wrapCommand`, `parseResult`, `checkpoint`, `onContainerReplaced` |
| `src/store`    | S3-compatible object store adapter (pre-signed URLs only reach the sandbox)                                                             |
| `helper/`      | `swvol`: sync/restore; `swlazy`: FUSE lower; `swvol-supervisor`: protected workloads; shared `swvol-core`                               |
| `image/`       | Image layer: `install-swvol.sh` + `swvol-init` (root boot step)                                                                         |
| `vectors/`     | Protocol test vectors shared by the TypeScript and Rust test-suites                                                                     |

Tables are in `@sourceweft/db` (`sandbox_volume*`). Apply volume migrations **0061–0066**
after main's skill-source migration 0060. Migration 0062 upgrades existing volume rows
conservatively instead of inventing confirmations. A developer database that manually applied
the earlier unpublished 0060–0065 volume series needs explicit ledger reconciliation; do not
blindly rerun the renamed create-table migrations.

## Current integration status

The deployment flag remains disabled by default. Neither shipped provider currently has the
complete protected bootstrap and typed control/file RPC integration. Runtime rejects volume
admission before creating an attachment when those capabilities are unavailable. Setting the
flag alone is not a supported way to enable this unfinished integration.

The current supervisor also has **no stable persistence-freeze capability**. A real workload
used a POSIX SIGCONT timer to resume itself after SIGSTOP had been acknowledged. The production
`freeze` RPC now returns `STABLE_FREEZE_UNAVAILABLE`; signal `pause` is diagnostic only and
never returns a durable-writer-stop proof. Runtime requires an explicitly verified kernel
freezer capability, a matching proof, and its own live barrier grant before checkpointing.
Unit-test stubs for a future cgroup-v2 freezer do not establish real provider support.

Direct hook-level tests use the hardened eager `full` restore path; `shadow` creates a separate
observation namespace and never restores or updates the primary volume. These tests do not
replace the protected runtime/provider acceptance gate. `swlazy mount-volume` consumes the
same chunked, compressed, hash-verified format as the sync helper and has Linux FUSE/overlay
acceptance coverage. Provider bootstrap has not yet wired that mount into the production
`full` lifecycle.

Host confirmation requires an active attachment's committed sequence. Database row locks,
attachment/epoch checks and an immutable commit receipt prevent competing hosts from accepting
each other's progress. Runtime requires database execution permits, a kernel-enforced freeze and an
out-of-band flush receipt; command stdout cannot authorize persistence or replay. File mutations
also await a confirmed barrier. A failed or uncertain flush
preserves its command result and must never cause an automatic command replay. Missing helper
state and changed boot identity require explicit recovery; they do not prove the local files
are disposable. Missing or altered user-writable stamps are not proof of physical instance loss.
If persistence succeeds but resume/release acknowledgement is lost, the confirmed sequence is
preserved while environment coordination remains pending. The user command is not replayed.

Persistent sandbox cancellation quarantines the attachment when the provider cannot prove
command termination. Automatic TTL deletion is deferred even after a successful checkpoint
until background writers can be drained. Operator recovery/cleanup remains necessary for
these retained instances. A verified session deletion response alone is insufficient: the
Cloudflare probe found that a completed command's background child can survive it.

The scheduler applies bounded batches of background WAL. An attachment-scoped capability
endpoint and independent helper control loop renew slots and bounded subsets of immutable
read locators. Tokens stay outside workload arguments/environment. Ordinary workload process
environment is an explicit non-secret allowlist, not the supervisor's environment.

Storage operations have deadlines and WAL downloads have a byte budget; unclassified GET
404 responses are errors, not absent WAL. The current large JSON limit still requires further
memory qualification and does not demonstrate a low RSS ceiling. Protocol validation matches
the actual helper's chunk, path-component, entry-shape and symlink bounds. Invalid Unicode
must be rejected before replacement decoding can change an indexed filename.

Per-volume transaction quotas cover logical bytes, files, entries and registered objects.
`service.maintenance.collect(volumeId)` defaults to a dry run and a 24-hour grace period.
Explicit deletion protects current files, all retained history, inline manifests and all
active/quarantined/draining attachments. Retired readers currently rely on retained history;
history expiration needs explicit reader-generation pins first. Unknown bucket objects and deleted-thread outbox cleanup are
not yet covered. No bucket-wide lifecycle expiration substitutes for this reference check.

Remaining production qualification includes the stronger durable-write path, protected provider
bootstrap, actual renewal/repair integration, safe draining and automatic recovery, scale/soak testing,
and the shadow observation period. A local test pass is not a production release approval.

## Tests

- `pnpm test` — protocol, hooks, shell-wrapper and storage deadline tests. Database cases are
  explicitly skipped unless `SANDBOX_VOLUME_TEST_DATABASE_URL` names a disposable PostgreSQL.
- `SANDBOX_VOLUME_TEST_DATABASE_URL=postgresql://... pnpm test` — adds real transaction,
  independent-process concurrency, migration, quota and GC tests in generated private schemas.
  A seeded state machine compares all historical/confirmed versions against an independent
  nested-tree oracle. Its object store is a persisted local fixture, **not real S3**.
  `SANDBOX_VOLUME_RANDOM_SEED` selects a uint32 seed and `SANDBOX_VOLUME_RANDOM_STEPS`
  selects 10–2000 steps (default four seeds, 140 steps each). Failures retain evidence;
  `SANDBOX_VOLUME_MODEL_PRESERVE=1` also retains successful schemas and ledgers.
  Reconnect with `tsx tests/scripts/verify-model-ledger.ts <evidence-directory>` and the
  explicit test database URL to verify the persisted confirmation ledger independently.
- `helper/test-linux.sh --with-fuse` — uses the pinned Linux builder, real inotify, a small
  ENOSPC filesystem and an explicitly privileged disposable FUSE/overlay test container
  with a 512-process limit. It also exercises real supervisor UID/namespace/crash behavior.
  It requires locked dependencies to be fetched first; it fails rather than downloading or
  changing toolchains during its offline tests. Omitting `--with-fuse` does not verify mounting.
- `SANDBOX_VOLUME_E2E=1 pnpm test:e2e` — real S3 and provider acceptance, requiring the test
  database URL, explicit S3 configuration and Cloudflare bridge settings. An optional
  `SANDBOX_VOLUME_E2E_ENV_FILE` may name an authorized configuration file; backend `.env` is
  never read implicitly. All objects use generated `_swvol-e2e/<run>/` prefixes, and all database
  rows use fresh schemas and test threads. Existing application threads are never selected.
  The sandbox suite also requires current helper binaries from `pnpm helper:build`.
  `contention.e2e.ts` covers real conditional-PUT races, concurrent WAL appliers, expired
  signatures and late old-writer uploads. `object-reader.e2e.ts` verifies bounded reads
  against real S3. Whole-instance destruction requires the additional explicit
  `SANDBOX_VOLUME_FAULT_E2E=1`; its ledger reports unconfirmed loss separately.
  The complete runtime/provider suite remains blocked until protected bootstrap is installed;
  hook-level success must not be reported as that suite passing.

`.github/workflows/sandbox-volume.yml` runs isolated PostgreSQL and explicit Linux filesystem
tests. Real cloud acceptance uses separate credentials and is not represented by skipped tests.

Status: see GitHub issue #228.

## Helper 0.3.0 recovery contract

All four Rust crates and `helper/VERSION` are versioned together. A deployment must install
and verify `swvol 0.3.0`; an older cached executable must fail the version check instead of
being used with these hooks. Immutable manifest objects remain protocol v1. The local pending
journal is now explicitly `SWVPEND2` and records its original manifest key. Ordinary recovery
rejects an unknown journal version or an epoch mismatch and retains its bytes. Only a
host-authorized explicit rebase may archive that journal in `.sourceweft/recovery` and rebuild
from local content. Uncontrolled upgrades must not delete, ignore, or reinterpret an old
pending journal.

Upgrade the matched helper bundle through a stopped, checkpointed/fenced lifecycle or a
verified fresh instance. Replacing a binary file beneath an already running daemon does not
upgrade that process and is not a supported activation procedure.

Version 0.3.0 rejects timestamp overflow that older release builds could wrap and confirm.
File, directory and symlink mtime use the signed 64-bit nanosecond range. Restore verifies
actual timestamps/modes before publishing readiness: a filesystem returning success after
clamping a timestamp is an error. Historical directory timestamps recorded as zero cannot
be reconstructed retroactively; a full barrier can capture the real times from a surviving
workspace for a new version.

Eager restore requires a quiescent target without existing user content. It returns
`RESTORE_TARGET_NOT_EMPTY` before altering the old attachment identity when content is present;
it does not overlay a restored tree onto a live or dirty workspace. Fresh-instance recovery
continues to work. Only the known empty platform directories `input`, `output` and `work`
may already exist; nonempty or symlinked entries are rejected. Unused empty platform directories
are retained, and matching placeholders are removed only with an empty-directory syscall before
exclusive publication. Files are built in a private staging directory using descriptor-relative
`openat` operations with `O_NOFOLLOW`, exclusive creation, and inode checks on reopened files.
Symlink target strings are preserved, but parent symlinks are never traversed. Top-level entries
are published with Linux `renameat2(RENAME_NOREPLACE)`. A competing entry is retained and causes
failure. Publishing multiple top-level entries is not a single filesystem transaction: a
conflict can leave staged and published restore content for explicit recovery, and no ready
identity is written. Failed downloads retain the staging tree rather than deleting user data.
Provider bootstrap must keep workloads stopped until the final identity is published.

`treehash` is a verification oracle, separate from manifest protocol v1. Its output now includes
`treehash_version: 2` and `algorithm: "blake3-framed-json-v2"`; it hashes length-framed structured
records, including supported directory/file/symlink mode and mtime. The former text encoding
could collide for distinct legal symlink layouts. Compare fingerprints only with the same
declared algorithm/version. Invalid UTF-8 paths or targets fail explicitly.

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

The implemented reader keeps a stable unprivileged FUSE dispatch process that owns INIT,
inode/open-handle state, and outstanding request/reply IDs. Bounded network and decompression
workers restart after failure; the dispatch process resubmits idempotent reads for the same
immutable chunk and returns only validated data. One deadline covers queue, shared-cache,
network and renewal waits; bounded short-lived failure records prevent waiters from repeatedly
starting a new full timeout. This provides worker recovery. If the
dispatch process itself crashes, the attachment must fail explicitly, preserve the writable
upper layer, and use a separately reviewed recovery procedure. It does not promise transparent
recovery of the entire FUSE daemon. Worker SIGKILL acceptance is distinct from this unresolved
dispatch-lifecycle gate.

The pinned fuser 0.15.1 encoder cannot correctly represent fractional timestamps before
the Unix epoch. Formal `mount-volume` refuses plans containing negative mtime before mounting;
it must not clamp them to zero or silently select eager mode. Eager restore's signed range
is tested separately and still depends on the target filesystem preserving the requested time.
