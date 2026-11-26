import type { ConnectorAdapter } from "@sourceweft/contracts";
import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { toBackendDiscourseManifest } from "./backend-manifest";

// replaced in Task 6: a marker adapter that only exposes the manifest. It
// discovers nothing and refuses every extract and action, so an enabled
// deployment can register the connector before the real adapter exists.
function createPlaceholderAdapter(): ConnectorAdapter {
  return {
    getManifest: toBackendDiscourseManifest,
    async *discover() {},
    async extract() {
      throw new Error("Discourse adapter is not implemented yet");
    },
    async executeAction() {
      throw new Error("Discourse adapter is not implemented yet");
    },
  };
}

/**
 * Discourse is gated behind a strict boolean deployment switch, exactly like
 * the RSS connector: absent, empty, `false`, or `0` leaves it unregistered so
 * the catalog hides it; `true` or `1` registers it; any other value is a
 * misconfiguration and the host refuses to start. The switch is read before
 * `publicFetch`, so a disabled deployment never fails startup over a fetch it
 * will not use. When enabled, Discourse needs the host's public-internet-only
 * fetch and fails fast rather than falling back to an unrestricted one.
 */
export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  publicFetch,
}): CapabilityConnectorContribution => {
  const activation = env
    .get("DISCOURSE_CONNECTOR_ENABLED")
    ?.trim()
    .toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("DISCOURSE_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  if (!publicFetch) {
    throw new Error(
      "Discourse connector requires a host-provided publicFetch; the host did not supply one",
    );
  }
  return {
    adapters: [createPlaceholderAdapter()],
    agentToolDefs: [],
  };
};
