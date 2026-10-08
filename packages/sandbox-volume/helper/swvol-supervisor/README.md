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

`freeze` always returns `STABLE_FREEZE_UNAVAILABLE`. Identity declares
`stable_freeze: false` and `freeze_mechanism: "signal-pause"`. This release has no
kernel-enforced stable freeze capability and must not enable production volume
attachment or durable operations.

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
`start`, `status`, `cancel`, `freeze` (unavailable), `pause`, `resume`, and `drain`. Mutating requests require
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
