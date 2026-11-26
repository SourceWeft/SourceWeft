import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createWordPressAdapter } from "./adapter";

/**
 * WordPress is gated behind a strict boolean deployment switch, exactly like
 * the other optional connectors: absent, empty, `false`, or `0` leaves it
 * unregistered so the catalog hides it; `true` or `1` registers it; any other
 * value is a misconfiguration and the host refuses to start. The switch is read
 * before either fetch seam, so a disabled deployment never fails startup over a
 * fetch it will not use.
 *
 * The one switch registers both connectors this package ships (the public site
 * and the Application Password site), so both appear in the catalog when it is
 * on and neither when it is off. When enabled, the public connector needs the
 * host's public-internet-only fetch and the login connector the credentialed
 * fetch; a missing seam fails fast rather than falling back to another fetch.
 */
export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  publicFetch,
  credentialedFetch,
  logger,
}): CapabilityConnectorContribution => {
  const activation = env
    .get("WORDPRESS_CONNECTOR_ENABLED")
    ?.trim()
    .toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("WORDPRESS_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  if (!publicFetch) {
    throw new Error(
      "WordPress connector requires a host-provided publicFetch; the host did not supply one",
    );
  }
  if (!credentialedFetch) {
    throw new Error(
      "WordPress connector requires a host-provided credentialedFetch; the host did not supply one",
    );
  }
  return {
    adapters: [
      createWordPressAdapter({ flavor: "public", publicFetch, logger }),
      createWordPressAdapter({
        flavor: "login",
        credentialedFetch,
        logger,
      }),
    ],
    agentToolDefs: [],
  };
};
