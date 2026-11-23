import type { ConnectorContribution } from "@sourceweft/capability-contracts";

/** Shape of an accepted feed URL: https only, a host with no `user:pass@`
 * userinfo, then an optional path, query (a token may live there) or fragment.
 * Kept in the schema so the server rejects a malformed value before any fetch. */
export const RSS_FEED_URL_PATTERN =
  "^https://[^/?#@\\s]{1,253}([/?#]\\S{0,2040})?$";

export const rssConnectorContribution = {
  id: "rss",
  title: "RSS / Atom feed",
  // A public feed needs no credential. The user-supplied URL is the only
  // configuration and may itself carry a token query.
  auth: { kind: "none" },
  sync: {
    supportsIncremental: true,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 30,
    resources: [
      {
        type: "feed_item",
        title: "Feed item",
        supportsDeleteDetection: false,
      },
    ],
  },
  actions: [],
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["feedUrl"],
    properties: {
      feedUrl: {
        type: "string",
        pattern: RSS_FEED_URL_PATTERN,
      },
    },
  },
} as const satisfies ConnectorContribution;
