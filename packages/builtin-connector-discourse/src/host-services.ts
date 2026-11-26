import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createDiscourseAdapter } from "./adapter";

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
  logger,
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
    adapters: [createDiscourseAdapter({ publicFetch, logger })],
    agentToolDefs: [],
  };
};
