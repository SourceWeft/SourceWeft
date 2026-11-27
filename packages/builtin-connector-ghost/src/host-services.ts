import type {
  ConnectorAdapter,
  ConnectorManifest,
} from "@sourceweft/contracts/connectors";
import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { toBackendGhostManifest } from "./backend-manifest";

/**
 * Ghost is gated behind a strict boolean deployment switch, exactly like the
 * other optional connectors (e.g. ZOTERO_CONNECTOR_ENABLED): absent, empty,
 * `false`, or `0` leaves it unregistered so the catalog hides it; `true` or
 * `1` registers it; any other value is a misconfiguration and the host refuses
 * to start. The switch is read before `credentialedFetch`, so a disabled
 * deployment never fails startup over a fetch it will not use. When enabled,
 * Ghost needs the host's credentialed fetch and fails fast rather than
 * falling back to an unrestricted one.
 */
export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  credentialedFetch,
}): CapabilityConnectorContribution => {
  const activation = env.get("GHOST_CONNECTOR_ENABLED")?.trim().toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("GHOST_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  if (!credentialedFetch) {
    throw new Error(
      "Ghost connector requires a host-provided credentialedFetch; the host did not supply one",
    );
  }
  return {
    adapters: [createPlaceholderAdapter(toBackendGhostManifest)],
    agentToolDefs: [],
  };
};

// replaced in Task 6: a marker adapter so the registration path is exercised
// before the real adapter exists. It declares the manifest and refuses every
// operation; it never reaches the network.
function createPlaceholderAdapter(
  getManifest: () => ConnectorManifest,
): ConnectorAdapter {
  const notImplemented = (): never => {
    throw new Error("Ghost connector adapter is not implemented yet");
  };
  return {
    capabilityId: "sourceweft/ghost",
    getManifest,
    discover: notImplemented,
    extract: notImplemented,
    executeAction: notImplemented,
  };
}
