/**
 * Public surface of the `stream/` subdomain (SSE delivery of thread runs)
 * toward its sibling subdomains `durable/` and `agent/`.
 *
 * T2.3: cross-subdomain imports are supposed to come through this file; the
 * boundary is enforced by `../architecture.test.ts`, and the deep imports
 * that predate it are frozen in that test's ALLOWED_CROSS_IMPORTS table.
 * This index deliberately re-exports only the members a sibling subdomain
 * actually references today — it grows as call sites migrate, it is not a
 * barrel for the whole directory. (The parent `threads/index.ts` is the
 * module-level surface and still imports specific files directly.)
 */

// Referenced by durable/runner.ts.
export { createThreadStreamErrorMessage } from "./error";
export { toSseData } from "./helpers";
export { ContentThreadStreamService } from "./service";

// Referenced by durable/service.ts and durable/types.ts.
export type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
} from "./types";
