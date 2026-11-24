import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createWebdavAdapter } from "./adapter";

/**
 * WebDAV is gated behind a strict boolean deployment switch, exactly like the
 * other optional connectors (e.g. RSS_CONNECTOR_ENABLED): absent, empty,
 * `false`, or `0` leaves it unregistered so the catalog hides it; `true` or
 * `1` registers it; any other value is a misconfiguration and the host refuses
 * to start. The switch is read before `credentialedFetch`, so a disabled
 * deployment never fails startup over a fetch it will not use. When enabled,
 * WebDAV needs the host's credentialed fetch (public HTTPS plus the
 * deployment's allowed private origins, cross-origin redirects refused) and
 * fails fast rather than falling back to an unrestricted one.
 */
export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  credentialedFetch,
  logger,
}): CapabilityConnectorContribution => {
  const activation = env.get("WEBDAV_CONNECTOR_ENABLED")?.trim().toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("WEBDAV_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  if (!credentialedFetch) {
    throw new Error(
      "WebDAV connector requires a host-provided credentialedFetch; the host did not supply one",
    );
  }
  return {
    adapters: [createWebdavAdapter({ credentialedFetch, logger })],
    agentToolDefs: [],
  };
};
