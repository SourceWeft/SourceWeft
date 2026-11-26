import type { ConnectorAdapter } from "@sourceweft/contracts";
import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { toBackendZoteroManifest } from "./backend-manifest";

// replaced in Task 7: a minimal stand-in so the enabled branch type-checks and
// registers the connector before the real adapter exists. It performs no I/O.
function placeholderAdapter(): ConnectorAdapter {
  const notImplemented = () => {
    throw new Error("Zotero connector adapter is not implemented yet");
  };
  return {
    capabilityId: "sourceweft/zotero",
    getManifest: toBackendZoteroManifest,
    credentialIdentity: notImplemented,
    discover: notImplemented,
    extract: notImplemented,
    executeAction: notImplemented,
  };
}

/**
 * Zotero is gated behind a strict boolean deployment switch, exactly like the
 * other optional connectors (e.g. WEBDAV_CONNECTOR_ENABLED): absent, empty,
 * `false`, or `0` leaves it unregistered so the catalog hides it; `true` or
 * `1` registers it; any other value is a misconfiguration and the host refuses
 * to start. The switch is read before `credentialedFetch`, so a disabled
 * deployment never fails startup over a fetch it will not use. When enabled,
 * Zotero needs the host's credentialed fetch and fails fast rather than
 * falling back to an unrestricted one.
 */
export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  credentialedFetch,
}): CapabilityConnectorContribution => {
  const activation = env.get("ZOTERO_CONNECTOR_ENABLED")?.trim().toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("ZOTERO_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  if (!credentialedFetch) {
    throw new Error(
      "Zotero connector requires a host-provided credentialedFetch; the host did not supply one",
    );
  }
  // replaced in Task 7: createZoteroAdapter({ credentialedFetch, logger })
  return { adapters: [placeholderAdapter()], agentToolDefs: [] };
};
