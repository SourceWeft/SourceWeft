/**
 * Public surface of the `durable/` subdomain (run lifecycle, plus the
 * room/presence services that physically live here) toward its sibling
 * subdomains `stream/` and `agent/`.
 *
 * T2.3: cross-subdomain imports are supposed to come through this file; the
 * boundary is enforced by `../architecture.test.ts`, and the deep imports
 * that predate it are frozen in that test's ALLOWED_CROSS_IMPORTS table.
 * This index deliberately re-exports only the members a sibling subdomain
 * actually references today — it grows as call sites migrate, it is not a
 * barrel for the whole directory. (The parent `threads/index.ts` is the
 * module-level surface and still imports specific files directly.)
 */

// Referenced by agent/capability-tools/host-services.ts.
export { requestChatThreadRunCancel } from "./repository";
export {
  createProtectedRunOperationCacheServices,
  createProtectedRunReceiptServices,
} from "./protected-agent-tool-state-repository";
