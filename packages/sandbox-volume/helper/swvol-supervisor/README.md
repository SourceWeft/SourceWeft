# swvol-supervisor

Linux workload supervisor for persistent-volume barriers and recovery. This crate
is not yet enabled by either shipped provider. A deployment must pass the process,
UID, filesystem, network, and database gates below before reporting protected
volume support.

## Boundary and admission

The daemon runs as root. Its state directory is root-owned mode 0700; its Unix
socket is owned by a separate control UID, mode 0600, under a root-owned directory.
The daemon checks `SO_PEERCRED` for every connection. The workload UID must differ
from root and the control UID. A fixed four-worker control pool and bounded pending
queue prevent a partial request from blocking all control traffic or spawning
unbounded threads. Each request has a fixed ten-second read deadline measured
from acceptance, including queue time; received bytes do not renew it. Responses
also use a fixed ten-second write budget. Workloads inherit only explicit non-secret toolchain/locale
variables; daemon credentials are cleared, and HOME points into the volume.

Each execution starts a dedicated PID namespace. The controller obtains a pidfd
for its own `unshare` process's direct child before authorizing any user work.
Namespace PID 1 runs the command with a separate UID/GID, no supplementary groups,
`no_new_privs`, and empty inherited/bounding capabilities. It stays alive while
background descendants exist. Normal command completion therefore preserves
background services; explicit cancellation terminates namespace PID 1 and waits
for kernel-confirmed exit, including detached descendants.

`freeze` is unavailable in every mode: default signal mode returns
`STABLE_FREEZE_UNAVAILABLE`, and explicit cgroup mode returns
`KERNEL_IO_QUIESCENCE_UNQUALIFIED`. Identity declares
`stable_freeze: false` and `freeze_mechanism: "signal-pause"`. Production volume attachment and durable operations remain disabled: no shipped
provider has passed the protected adapter and kernel-freezer qualification.

`pause` is an explicit diagnostic signal operation. It reports only
`observed_stopped: true`, `signal_pause: true`, and `stable_freeze: false`;
`resume` takes its `pause_id`. A workload can arm a POSIX
`timer_create(CLOCK_MONOTONIC, SIGEV_SIGNAL, SIGCONT)` timer before pausing. The
kernel then resumes the workload without a user-space handler, and writes continue
after a successful pause response. Observing all threads in T state is therefore
not a persistence barrier. Earlier SIGSTOP-based freeze safety claims and pre-fix
local bundles are invalid. Do not use pause for checkpoint or durability confirmation.

`drain` closes admission and terminates every managed namespace. It is a proof
about managed workloads, not about ordinary provider SDK uploads or other external
writers. Database lifecycle code must refuse to retire active external-writer
permits based on this proof.

## Restart and durability

The daemon holds an exclusive state-directory lock. Root-owned namespace journals
record boot ID, PID, start time, and namespace identity before the start receipt is
published. After a crash, the next daemon verifies and stops matching old namespace
processes with pidfds before admitting requests. It reports the previous controller
identity and a BLAKE3 journal digest and starts with admission closed. Backend
recovery must checkpoint the preserved writable filesystem before retiring the old
owner and authorizing a new admission generation. Unknown commands are never
replayed automatically.

The supervisor preserves local files; it does not upload them or acknowledge S3
persistence. A stop or diagnostic pause response is not a persistence receipt. Physical provider
loss before a confirmed volume barrier remains an unconfirmed-data failure.

## Host control

```
swvol-supervisor serve SOCKET STATE_DIR WORKSPACE WORKLOAD_UID CONTROL_UID
swvol-supervisor request SOCKET < request.json
```

Requests are bounded, newline-delimited JSON. Captured stdout/stderr are capped at
8 MiB each. Status defaults to 64 KiB per stream, accepts `max_output_bytes` up to
1 MiB per stream, and explicitly reports truncation. Completed receipts preserve
exit code and final output boundaries and remain readable after daemon restart;
reading them never starts a command. Retrying the last successful resume is
idempotent, while reusing a completed pause identity is rejected.

Operations are `identity`, `open`,
`start`, `status`, `cancel`, `freeze` (unavailable), diagnostic `pause`, `pause_kernel`,
`resume`, `thaw`, and `drain`. Mutating requests require
the current supervisor nonce. `start` requires a host-issued execution ID and never
replays an existing ID. Control operations are not model tools and must never be
exposed through an unauthenticated container endpoint.

## Deployment gates

- A stable kernel-enforced freeze mechanism and matching live barrier proof are
  required before attachment/execution. No shipped provider currently supplies
  them. TypeScript contract tests use explicitly idealized capabilities; those
  mocks are not provider or kernel verification. Signal pause cannot satisfy this gate.

- The provider must launch every ordinary command through the workload UID/PID
  namespace. Generic `executeSystem`, file reads, writes, and uploads must not become
  privileged merely because a supervisor is installed.
- Fixed privileged helper RPCs are separate from ordinary execution. Workloads may
  not reach the control Unix socket, private state, host `/proc`, or provider control
  TCP ports. Network isolation must preserve normal application networking and be
  tested on the actual provider.
- Managed file mutations need a supervisor-owned file RPC or a managed namespace
  writer. Wrapping an ordinary SDK upload in a database permit does not put that
  upload inside this process boundary.
- Provider image boot capability, helper receipts, command results, concurrent file
  mutations, interrupted barriers, restart recovery, and bounded output must all be
  verified before activation. Missing capabilities are explicit startup failures.

## Linux acceptance

Use the repository's pinned Linux builder with an isolated target volume and no
network. The tests intentionally require an isolated privileged container:

```
cargo test --locked --offline --target x86_64-unknown-linux-musl \
  --test linux_supervisor -- --ignored --nocapture
```

The suite runs real namespace and UID transitions, background/detached writers,
diagnostic pause/resume, the POSIX SIGCONT counterexample, cancellation, closed-admission checks, repeated daemon crashes,
lost acknowledgements, synthetic-secret isolation, output floods, and hostile
control requests. Run these with a process limit of 512 and a memory limit; the
fork/thread fixture itself is capped at four child processes, three writer threads
per child, and ten seconds. It uses the pinned builder's matching musl cross-linker.

Completed PID namespaces are collected on control requests: the controller waits for pidfd-confirmed namespace teardown, reaps the launcher, and releases kernel handles. Main-command completion with live background writers does not permit collection. Root-owned result journals and execution-ID replay fences remain intact. Linux regression coverage runs 600 sequential commands under a 256-FD supervisor limit and a 512-process container limit.

## Explicit kernel-freezer experiment (provider qualification pending)

An administrative test may start `serve ... --cgroup-parent CANONICAL_PARENT`.
Startup requires a real cgroup-v2 filesystem, root-owned controls, and the actual
controller PID in that parent. A private journal binds a unique owned subtree to
boot/controller identity. The controller stays outside; launchers enter per-command
leaves before unshare or user execution, and unprivileged workloads cannot migrate
out. The default mode remains unchanged and cannot acknowledge Freeze.

In explicit mode, diagnostic `pause_kernel(pause_id)` closes admission and waits
up to five seconds for the kernel's hierarchical cgroup.events frozen observation.
It reports only `user_threads_frozen: true`, `diagnostic_only: true`, and
`kernel_io_quiescence: unqualified`, never all_writers_stopped or a durable barrier
proof. Diagnostic `thaw(pause_id)` resumes that subtree; signal `resume(pause_id)`
cannot thaw a kernel pause. Identity always declares stable_freeze=false, separately
reporting the user_threads_freeze mechanism and unqualified kernel I/O state.
Namespace cancellation/drain still prove init exit and reap frozen launchers.
Completed leaves and empty journal-owned trees are reclaimed without deleting
result journals or user files. Invalid delegation, unexpected live recovery
processes, and incomplete kernel observations fail closed.

A real native-AIO counterexample submitted 64 successful O_DIRECT writes to a
preallocated private 256 MiB file. At cgroup frozen acknowledgement, zero had
completed; 350 ms later all 64 had completed while frozen remained 1. io_getevents
verified every write's byte count. Freezing user threads therefore does not prove
pending kernel I/O is drained. Earlier local pre-AIO KernelTrue bundles must not
be activated. No syscall is silently disabled, and termination is not substituted
for a live workspace barrier.

These local kernel tests do not establish a production provider capability. The
stock root command/file API must not bypass the workload boundary, and pending
asynchronous kernel I/O still needs qualification. Only a complete provider image,
protected adapter, and real cloud acceptance may enable durable execution.

The reproducible `../test-linux.sh --with-fuse` acceptance selects 21 x86_64
namespace/security cases and a separate native ARM musl scenario with a real FUSE
ASYNC_DIO write gate. The original ordinary-disk native-AIO experiment remains
available as an explicitly manual diagnostic. Its latest run had 51 completions
before pause and 64 by ACK, leaving no pending observation window: inconclusive,
not a pass. Earlier real ordinary-disk counterexamples remain evidence, but the
controlled FUSE test does not retrospectively change that result.

The mandatory gated scenario requires the kernel to advertise FUSE_ASYNC_DIO.
Its test-only fuser=0.15.1 dependency uses abi-7-31 and requests 1 MiB writes and
512 background requests; it is absent from the production dependency graph. The
unchanged UID65534 C workload submits 64 real 4 MiB O_DIRECT native-AIO requests.
The kernel delivers 256 actual FUSE writes. A controller outside the frozen leaf
stores their payload in private synced spool files while withholding all replies.
Backing is really preallocated, and its zero-content SHA256 is checked before
release. Once pause ACK and frozen1 are observed with eventfd0, the controller
releases actual backing writes and only then replies. At 350 ms completions must
have increased while frozen1 remains. After thaw, all64 successful write results,
256 MiB, io_destroy, and the entire backing SHA256 are checked.

Spool sync_data is required preparation: the initial prototype left private data
dirty and its first backing pwrite stalled over a second in balance_dirty_pages.
Synchronizing only the private spool/allocation before freeze fixed that measured
interference; three bounded native prototype runs then observed31/38/57 completed
writes at350ms. Neither the time window nor data/resource assertions were relaxed.
The acceptance container retains 2 CPUs,768 MiB,512 PIDs, an8 MiB private control
journal and the pinned ARM musl compiler (Rust1.95.0). QEMU syscall emulation is
not an alternate qualification path. The CI budget stays35 minutes without GB
benchmarks.

The same named scenario exercises failed cleanup with an independent real4096-byte
synchronous FUSE write held open. Its kernel pause correctly times out, never
claiming stopped writers. Cleanup binds the exact canonical mount, mount ID,
fsname and device to a pre-opened connection abort fd, and rechecks that identity
before aborting. It never guesses a connection from global lists. Only that owned
connection is aborted/detached; release/dispatch threads are joined with bounded
waiting, the owned mount is checked absent, and the namespace is drained. A changed
identity or unresolved cleanup retains evidence and fails the test. This is test
resource cleanup, not transparent recovery of production file descriptors.

Both real provider images still lack writable delegation for their stock nonroot
SDK identity. Neither the local FUSE test nor the independent root image qualifies
a complete protected provider adapter. Production Freeze always rejects: cgroup
user-thread stopping does not establish kernel-I/O quiescence, an external
persistence receipt, or a durable upper filesystem. The ordinary-disk manual test
and this controlled FUSE boundary must remain separately reported.
