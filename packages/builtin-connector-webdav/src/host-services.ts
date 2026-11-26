import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createWebdavAdapter } from "./adapter";
import { nextcloudFlavor } from "./nextcloud/flavor";

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
 *
 * The one switch registers both connectors this package ships — plain WebDAV and
 * Nextcloud, two flavors of the same adapter — so both appear in the catalog
 * when it is on and neither when it is off. They share the same credentialed
 * fetch and the same allowed-origins allowlist; there is no Nextcloud-specific
 * environment variable.
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
    adapters: [
      createWebdavAdapter({ credentialedFetch, logger }),
      createWebdavAdapter({
        credentialedFetch,
        logger,
        flavor: nextcloudFlavor,
      }),
    ],
    agentToolDefs: [],
  };
};
