import {
  discoverCapabilities,
  type DiscoveredCapabilityRecord,
} from "@sourceweft/capability-runtime";
import { resolveBackendRuntimePath } from "../../../shared/runtime-paths";

export type BackendCapabilityRuntimeAdapter = {
  readonly discoverRecords: () => Promise<readonly DiscoveredCapabilityRecord[]>;
};

export function resolveCapabilityPackagesRoot() {
  return resolveBackendRuntimePath({
    candidates: ["../../packages", "../packages"],
    envVar: "SOURCEWEFT_CAPABILITY_PACKAGES_DIR",
    label: "capability packages directory",
  });
}

export function createBackendCapabilityRuntimeAdapter(): BackendCapabilityRuntimeAdapter {
  return {
    async discoverRecords() {
      const discovery = await discoverCapabilities({
        roots: [resolveCapabilityPackagesRoot()],
      });
      return discovery.records;
    },
  };
}
