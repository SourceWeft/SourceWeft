import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

const activation = {
  default: "off",
  userControl: "enable-disable",
  skill: { declarable: true, activates: true },
} as const;
const configuration = {
  configurable: true,
  configKeys: ["connectorId"],
} as const;
const common = {
  domain: "connector",
  activation,
  configuration,
  slash: { iconName: "gmail", iconTone: "brand", supportsCommand: true },
} as const;

export const gmailAgentToolDefs = [
  defineAgentTool({
    ...common,
    id: "searchGmailMessages",
    name: "search_gmail_messages",
    capabilities: ["connector", "gmail", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Search Gmail",
      description: "Search the connected Gmail mailbox",
    },
  }),
  defineAgentTool({
    ...common,
    id: "getGmailMessage",
    name: "get_gmail_message",
    capabilities: ["connector", "gmail", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Read Gmail message",
      description: "Read a selected Gmail message",
    },
  }),
  defineAgentTool({
    ...common,
    id: "getGmailThread",
    name: "get_gmail_thread",
    capabilities: ["connector", "gmail", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Read Gmail thread",
      description: "Read a selected Gmail thread",
    },
  }),
  defineAgentTool({
    ...common,
    id: "sendGmailMessage",
    name: "send_gmail_message",
    capabilities: ["connector", "gmail", "connector_write"],
    defaultPermission: "ask",
    riskLevel: "high",
    slash: {
      ...common.slash,
      displayName: "Send Gmail message",
      description: "Propose one email for explicit review and approval",
    },
  }),
];
