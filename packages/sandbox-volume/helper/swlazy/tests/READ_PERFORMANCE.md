# Manual read-performance evidence

`read_performance.py` retains the paired replay and observation harness used to
evaluate a **rejected** 16 MiB / 500 ms raw-sharing candidate. That candidate is
not part of the current helper. The product keeps its prior FIFO worker queue,
disk CAS cache and complete chunk-integrity checks. A lower median did not
justify shipping its severe second-pair tail regression.

The runner uses the unchanged `swvol/tests/linux_gib.rs` ignored
`gib_read_replay_profile` fixture. Two invocations give the explicit order
A1, B1, A2 / B2, A3, B3. Each invocation verifies the entire retained 8 GiB
source with the independent system SHA256 oracle **inside** its original
300-second budget. It never regenerates or modifies the source.

Use the pinned Linux builder and immutable **Linux named-volume** executable
snapshots. Verify the baseline, candidate and fixture SHA256, version and build
mode before running; a host bind-mounted executable is a different execution
filesystem and must not be silently substituted. The runner expects the
archived sharing candidate's opt-in chunk trace. A different proposed algorithm
requires an explicit change to that experiment's contract, not bypassing a
missing trace assertion.

The fixed workload is eight readers, 128 deterministic 1 MiB ranges from the
same 8 GiB file, seed `0x228003005eed8a71`, and a fresh 8 MiB disk cache for each
trial. The container must have 2 CPUs, 1 GiB, no swap, 512 PIDs and real FUSE
mount privileges; these limits are checked from cgroup files. The retained data
volume is mounted read-only. Each 1 MiB result is compared with the original
source, and the plan's immutable fields must match the retained plan.

The 160 MiB RSS acceptance threshold includes the fixture, dispatch, content
workers and Python observer. An additional conservative bound checks the
contemporaneously observed data-process HWM sum. **50 ms is the requested poll
delay, not a promise of continuous kernel enforcement**: the runner records the
actual maximum observation interval, which reached 3,025 ms in the rejected
experiment. The kernel-enforced memory budget remains the original 1 GiB
cgroup limit. Do not claim that polling proves no unobserved transient peak.

One-second JSONL diagnostics preserve process identity, per-role CPU ticks and
I/O accounting, cgroup CPU/throttle, I/O, memory/refault and PSI counters, plus
VM-global counters. Missing readings remain explicit. CPU/pressure deltas
provide observations, not proof of an external root cause. Optional existing
host tools may record host I/O; do not install a different tool or change the
image merely to fill an unavailable metric.

Run the retained manual observer inside that prepared container:

```sh
python3 /exec/read_performance-diagnostic.py \
  /exec/fixture /exec/baseline /exec/candidate \
  /gib/RETAINED_SINGLE8G_CASE
```

The fixed code writes raw evidence below `/profile/paired-read-*` and preserves
failed runs. Completion means byte/resource assertions and six trials ran;
it does **not** mean the candidate passed performance acceptance. Review every
paired range count, elapsed time, p95 and worst latency, not just medians.
No part of this read-stage replay establishes fresh capture/restore durability,
whole-dispatch recovery or production Freeze support.
