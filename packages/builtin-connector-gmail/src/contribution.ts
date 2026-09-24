import type { ConnectorContribution } from "@sourceweft/capability-contracts";

export const GMAIL_READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const id = (description: string) => ({
  type: "string",
  minLength: 1,
  description,
});

export const gmailConnectorContribution = {
  id: "gmail",
  title: "Gmail",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE],
    authorizationParams: {
      access_type: "offline",
      prompt: "consent",
    },
    sendScope: true,
  },
  sync: {
    supportsIncremental: true,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "gmail_message",
        title: "Gmail message",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "gmail.message.search",
      title: "Search Gmail messages",
      agentToolName: "search_gmail_messages",
      description:
        "Search this authorized Gmail mailbox for explicit, exact, unread, or newest-mail requests. Use indexed sources for broad historical or cross-source synthesis. Results contain metadata and links; read a selected message for its body. If an indexed source and a live result share the same Gmail message ID or URL, use one citation and prefer the newer live result.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 512 },
          maxResults: { type: "integer", minimum: 1, maximum: 50 },
          pageToken: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: "gmail.message.read",
      title: "Read Gmail message",
      agentToolName: "get_gmail_message",
      description:
        "Read one selected Gmail message by ID and return safe text with its source link.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        required: ["messageId"],
        additionalProperties: false,
        properties: { messageId: id("Gmail message ID returned by search") },
      },
    },
    {
      id: "gmail.thread.read",
      title: "Read Gmail thread",
      agentToolName: "get_gmail_thread",
      description:
        "Read one selected Gmail thread by ID and return bounded messages with source links.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        additionalProperties: false,
        properties: { threadId: id("Gmail thread ID returned by search") },
      },
    },
    {
      id: "gmail.labels.list",
      title: "List Gmail labels",
      description: "List accessible Gmail labels for indexing selection.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      id: "gmail.message.send",
      title: "Send Gmail message",
      agentToolName: "send_gmail_message",
      description:
        "Propose one new plain-text email. The user must review and approve the exact sender, recipients, subject, and body before it is sent.",
      capabilities: ["connector_write", "connector_create"],
      risk: "high",
      requiresApproval: true,
      requestPrivacy: "encrypted",
      allowStandingApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        required: ["to", "subject", "body"],
        additionalProperties: false,
        properties: {
          to: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string" },
          },
          cc: { type: "array", maxItems: 20, items: { type: "string" } },
          bcc: { type: "array", maxItems: 20, items: { type: "string" } },
          subject: { type: "string", minLength: 1, maxLength: 998 },
          body: { type: "string", minLength: 1, maxLength: 100000 },
        },
      },
    },
  ],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      liveSearchEnabled: { type: "boolean" },
      indexingEnabled: { type: "boolean" },
      labelIds: { type: "array", maxItems: 20, items: { type: "string" } },
      after: { type: "string" },
      maxMessages: { type: "integer", minimum: 1, maximum: 10000 },
    },
  },
} as const satisfies ConnectorContribution;
