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

Current local acceptance includes 22 isolated Linux regression cases with pids-limit 512 and
768 MiB memory, including the opt-in kernel path and the default rejection path.
This is local Linux evidence only. Both original cloud provider images currently
lack delegation for their nonroot SDK execution identity; the independent root
Cloudflare image has not yet qualified. A user-thread freezer is not an external
persistence receipt and does not by itself prove that already-submitted kernel
AIO/io_uring work has completed. That requires a separate kernel-I/O probe and
quiescence design before the protected provider adapter can be activated.


The native-AIO regression must run the supervisor and syscall workload on the
builder's native architecture. On an ARM host, the pinned aarch64 builder exercises
real kernel AIO; x86 workload execution through QEMU can return ENOSYS, and an
emulated supervisor can add enough control latency to drain the pending window
before its acknowledgement. Such runs are explicitly inconclusive, not passes.
That case uses an 8 MiB private tmpfs for the root-owned control journal so its
fsync cannot incidentally synchronize the workload filesystem. The other lifecycle
cases retain their disk-backed state. The test verifies both actual successful
AIO completions after diagnostic pause and unconditional production Freeze refusal.

The reproducible `../test-linux.sh --with-fuse` entry explicitly runs the other
21 namespace/security cases with the pinned x86_64 target, then requires the AIO
case on an ARM64 Docker host using the pinned aarch64 builder. Both the supervisor
and C syscall fixture use aarch64 musl; no GNU fixture or QEMU syscall substitute
qualifies this phase. Unsupported host architecture fails rather than skips it.
The CI job preserves its 35-minute budget and runs no manual gigabyte benchmarks.
