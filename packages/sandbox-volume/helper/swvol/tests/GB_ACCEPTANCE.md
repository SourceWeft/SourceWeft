# Manual GiB acceptance

Run from the repository root:

```sh
packages/sandbox-volume/helper/test-gib.sh ordinary2g
packages/sandbox-volume/helper/test-gib.sh single8g
# No independent control endpoint: 64-slot host renewal and crash between windows.
packages/sandbox-volume/helper/test-gib.sh ordinary2g-retry
packages/sandbox-volume/helper/test-gib.sh single8g-retry
```

These explicit, ignored tests are not part of the default Linux CI suite. Run one
case at a time. The script builds before starting the workload budget, uses the
same pinned x86_64 musl builder as the helper, and does not rebuild `dist` or
replace a running daemon. The 8 GiB case requires a privileged disposable Docker
container with a real FUSE device.

| Case | Initial data actually written | CPU / RAM / PIDs | Hard timeout |
| --- | --- | --- | --- |
| `ordinary2g` | 1,024 distinct 2 MiB files across 64 directories; 64 symlinks | 2 / 1 GiB, no swap / 512 | 1,200 s |
| `single8g` | One 8 GiB file; 64 directories and 64 symlinks | 2 / 1 GiB, no swap / 512 | 3,600 s |

Both use deterministic SplitMix64 bytes with seed `0x228003005eed8a71`, write every
byte and fsync, check allocated file blocks, and require stored compressed objects
to exceed 98% of the initial source bytes. Sparse files, zero-filled data and
logical-size-only measurements do not qualify. Allow approximately 8 GiB and
28 GiB of real free disk respectively; data is retained rather than silently
removed on success or failure.

The object service streams immutable PUT/GET bodies to disk. Its authenticated
control endpoint issues at most 64 pack slots in each response. A real helper
control poll renews slots during capture; the test records every `nextPack` and
requires crossing the first grant window. The `-retry` variants deliberately omit
`control.json`; only the fixture host publishes the next 64-slot grant after exit
76, and it kills/restarts the daemon between every window. The first new pack
must not equal the original first pack, exposing the old retransmission failure.
This exercises helper progress against a local HTTP fixture, not Cloudflare, R2
or the host service's independent HEAD/proof and time-budget enforcement.

System `sha256sum`, separately from the helper's BLAKE3 implementation, creates an
oracle before capture and after deterministic incremental edits. Restoration must
match every file hash and every file/directory/symlink type, mode, nanosecond mtime
and link target. Confirmed daemon SIGKILL/restart must produce neither a new commit
nor a reupload. Incremental uploads must remain below 128 MiB. The 8 GiB case also
checks 128 deterministic 1 MiB ranges using eight concurrent readers against the
original file, with an 8 MiB FUSE disk cache.

Each run logs actual PUT/GET byte counts, stored and allocated bytes, phase timing,
control windows, process VmHWM and aggregate sampled RSS. Cache and process samples
are collected every 50 ms. Cgroup memory peak includes filesystem page cache; it
is distinct from process RSS. HTTP progress prints every 15 seconds and large-file
generation every 512 MiB. A timeout or resource failure is a failure of that fixed
case, not permission to rerun a smaller dataset or increase its limits.

Set `SWVOL_GIB_VOLUME` to choose the retained Docker data volume (default
`swvol-gib-acceptance`) and `SWVOL_GIB_LOG_DIR` to choose the host log directory
(default `/tmp`). The `GIB_START` line identifies the `/gib/<case>-<timestamp>`
directory containing the source, object store, restored tree, independent oracle
JSON files, command outputs and `report.json`. The log records the pinned image,
Linux kernel and guest disk capacity. Check host free disk as well: Docker's
virtual disk capacity can exceed the host's available physical storage.

This is a helper data-path test with a known, stopped fixture writer. It does not
use or qualify production Freeze, does not establish provider-loss durability for
unconfirmed writes, and does not enable the production volume lifecycle gate.

## Unconfirmed upload receipts

The helper keeps successful immutable-pack receipts separate from `State.have`
and from committed file entries. A receipt is eligible only after successful PUT
and durable local publication; replay rechecks scope, checksum, pack bounds and
filesystem durability. The journal is bounded at 32 MiB per file, 128 MiB total
and 65,536 directory entries (including incomplete temporary writes). Exceeding a
bound fails explicitly and preserves existing data. Scope creation uses a private
staging directory and an exclusive atomic rename, so ENOSPC cannot expose a
half-initialized active journal.

Exit 76 may include compact `capture_progress` with the actor, boot, epoch, base
sequence, durable counts/digest, next reservation and the last 64 actual uploaded
pack numbers. The explicit numbers preserve holes left by inline writes or a
crashed reservation. Progress does not advance a sequence or confirm a partial
file. Rebase archives mismatched receipts; a repeated explicit rebase of the same
epoch/head may resume its own receipts. Upload failures, malformed records and
failed state commits never become a successful complete snapshot.
