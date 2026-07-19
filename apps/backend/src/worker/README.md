# worker

Purpose of this directory:

- Consume queued jobs.
- Execute async or heavy tasks outside API request lifecycle.
- Update job status and events.

`main.ts` is the worker entry point.

## Layout

- `deliverable-host/` — the generic deliverable pipeline host: stage runner
  (budget/retry/checkpoint), model-usage metering, host context assembly
  (model gateway + storage + audio + sandbox sessions), the orchestrator
  (`host.ts`) and manifest-driven pipeline discovery (`registry.ts`).
  Capability packages declare `runtime.pipeline` on a tool contribution and
  export `createDeliverablePipelines`; the host registers their job names on
  the deliverables queue (registry falls back to its builtin module map when
  manifest discovery is unavailable). Adding a deliverable capability
  requires no worker changes beyond one literal entry in the registry's
  builtin module map (a tsup bundling constraint).
- `processors/` — per-job-type processors for the primary queue only; no
  per-capability files live on the worker side.
- `job-isolation.ts` — per-job async context + error normalization shared by
  both queues.
