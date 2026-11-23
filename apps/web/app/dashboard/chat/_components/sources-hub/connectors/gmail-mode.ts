import type { ConnectorManifestInfo } from "./types";

export type GmailUsageMode = "tools" | "index" | "both";

export function parseGmailUsageMode(value: unknown): GmailUsageMode {
  return value === "index" || value === "both" ? value : "tools";
}

export function gmailConfigForMode(mode: GmailUsageMode) {
  return {
    liveSearchEnabled: mode !== "index",
    indexingEnabled: mode !== "tools",
    labelIds: [],
    maxMessages: 500,
  };
}

/**
 * Whether connecting (or reconnecting) a connector of this type must first
 * show `GmailBrokerNoticeDialog`: Google's consent screen for a
 * Composio-brokered Gmail names Composio, not SourceWeft. Every entry point
 * that sends the user to Google for Gmail goes through this one check.
 */
export function needsGmailBrokerNotice(
  connectorType: string,
  info: ConnectorManifestInfo | undefined,
) {
  return connectorType === "gmail" && info?.broker === "composio";
}
