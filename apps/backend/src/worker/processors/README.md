# processors

Purpose of this directory:

- Implement job-type-specific execution logic for the primary queue.
- Keep processors focused and testable.

Deliverable pipelines (deliverables queue) do not live here: their logic
belongs to the owning capability package (`packages/builtin-tool-*/src/pipeline/`)
and runs on the generic host in `../deliverable-host/`, which discovers and
registers them from capability manifests (with a builtin-module fallback
inside the registry). No per-capability files exist on the worker side.
