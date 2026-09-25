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
