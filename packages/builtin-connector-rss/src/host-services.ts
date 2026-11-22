import type {
  CapabilityConnectorContribution,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createRssConnectorAdapter } from "./adapter";

/**
 * RSS reads no environment variable: its visibility is the `rss` preview gate,
 * not a deployment switch. It does need the host's public-internet-only fetch,
 * so a host that cannot provide one fails fast rather than falling back to an
 * unrestricted fetch.
 */
export const createConnectorAdapters: CreateConnectorAdapters = ({
  publicFetch,
  logger,
}): CapabilityConnectorContribution => {
  if (!publicFetch) {
    throw new Error(
      "RSS connector requires a host-provided publicFetch; the host did not supply one",
    );
  }
  return {
    adapters: [createRssConnectorAdapter({ publicFetch, logger })],
    agentToolDefs: [],
  };
};
