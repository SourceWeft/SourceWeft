# swvol-supervisor

Linux workload supervisor for persistent-volume barriers and recovery. This crate
is not yet enabled by either shipped provider. A deployment must pass the process,
UID, filesystem, network, and database gates below before reporting protected
volume support.

## Boundary and admission

The daemon runs as root. Its state directory is root-owned mode 0700; its Unix
socket is owned by a separate control UID, mode 0600, under a root-owned directory.
The daemon checks `SO_PEERCRED` for every connection. The workload UID must differ
from root and the control UID.

Each execution starts a dedicated PID namespace. The controller obtains a pidfd
for its own `unshare` process's direct child before authorizing any user work.
Namespace PID 1 runs the command with a separate UID/GID, no supplementary groups,
`no_new_privs`, and empty inherited/bounding capabilities. It stays alive while
background descendants exist. Normal command completion therefore preserves
background services; explicit cancellation terminates namespace PID 1 and waits
for kernel-confirmed exit, including detached descendants.

`freeze` closes admission, asks each namespace init to stop its descendants, and
requires every observed workload thread to be stopped or exited. A timeout or
uninterruptible writer produces no freeze acknowledgement. `resume` requires the
same freeze identity. A durable barrier must run after the freeze acknowledgement
and before resume. The backend releases its database permit only after the new
barrier is confirmed and resume succeeds.

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
persistence. A stop/freeze response is not a persistence receipt. Physical provider
loss before a confirmed volume barrier remains an unconfirmed-data failure.

## Host control

```
swvol-supervisor serve SOCKET STATE_DIR WORKSPACE WORKLOAD_UID CONTROL_UID
swvol-supervisor request SOCKET < request.json
```

Requests are bounded, newline-delimited JSON. Operations are `identity`, `open`,
`start`, `status`, `cancel`, `freeze`, `resume`, and `drain`. Mutating requests require
the current supervisor nonce. `start` requires a host-issued execution ID and never
replays an existing ID. Control operations are not model tools and must never be
exposed through an unauthenticated container endpoint.

## Deployment gates

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
freeze/resume, cancellation, closed-admission checks, and daemon crash recovery.
