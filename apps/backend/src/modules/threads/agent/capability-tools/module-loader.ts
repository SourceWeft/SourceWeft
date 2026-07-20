import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import { loadCapabilityEntryModule } from "../../../capabilities/entry-module-loader";
import type { CapabilityAgentToolModule } from "./types";

/**
 * The turn binder's view of a capability entry module.
 *
 * Loading, caching and failure handling are shared with every other host that
 * reaches into a capability entry module (connector adapters, the web
 * provider); only the narrowing to `createCapabilityAgentTools` belongs here.
 */
export function loadCapabilityAgentToolModule(
  record: DiscoveredCapabilityRecord,
): Promise<CapabilityAgentToolModule | null> {
  return loadCapabilityEntryModule(
    record,
  ) as Promise<CapabilityAgentToolModule | null>;
}
