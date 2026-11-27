import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import {
  wordpressActions,
  wordpressItemsSchema,
  wordpressSelection,
  wordpressSiteUrlSchema,
  wordpressSync,
} from "./contribution";

/** A WordPress site read with an Application Password (HTTP Basic). The
 * username and password are stored encrypted as a connector account and are
 * never part of the configuration below. */
export const wordpressLoginConnectorContribution = {
  id: "wordpress_login",
  title: "WordPress site (login)",
  auth: { kind: "credential", scheme: "basic" },
  sync: wordpressSync(),
  actions: wordpressActions("wordpress_login"),
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["siteUrl"],
    properties: {
      siteUrl: wordpressSiteUrlSchema,
      items: wordpressItemsSchema,
      // Draft, pending and private content is read only when asked for.
      includeUnpublished: { type: "boolean", default: false },
    },
  },
  selection: wordpressSelection("wordpress_login"),
} as const satisfies ConnectorContribution;
