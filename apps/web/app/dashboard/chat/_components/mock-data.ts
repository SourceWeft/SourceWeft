import type { UIMessage } from "ai";

export type AppRailItem = {
  label: string;
  href: string;
  active?: boolean;
  badge?: string;
};

export type ChatItem = {
  id: string;
  title: string;
  updatedAt: string;
  sourceCount: number;
  status?: "ready" | "running" | "attention";
};

export type SourceItem = {
  id: string;
  title: string;
  type: "PDF" | "DOC" | "WEB" | "NOTE";
  status: "Indexed" | "Syncing" | "Needs review";
  meta: string;
  folder?: string;
  storageKey?: string | null;
};

export type CitationItem = {
  id: string;
  sourceTitle: string;
  messageLabel: string;
  excerpt: string;
};

export type ConnectorItem = {
  id: string;
  name: string;
  status: "Connected" | "Syncing" | "Action needed";
  meta: string;
};

export const appRailItems: AppRailItem[] = [
  { label: "Chat", href: "/dashboard/chat", active: true },
  { label: "Docs", href: "/dashboard" },
  { label: "Artifacts", href: "/dashboard" },
  { label: "Inbox", href: "/dashboard" },
  { label: "Team", href: "/dashboard/team" },
  { label: "Billing", href: "/dashboard/billing" },
  { label: "Settings", href: "/dashboard/settings" },
];

export const workspaceSummary = {
  organizationName: "SourceWeft Lab",
  workspaceName: "AI Research Desk",
  workspaceMeta: "12 sources · 4 collaborators",
};

function isoMinutesAgo(minutesAgo: number) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function isoHoursAgo(hoursAgo: number) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

export const sharedChats: ChatItem[] = [
  {
    id: "shared-1",
    title: "Q2 launch narrative and evidence map",
    updatedAt: isoMinutesAgo(12),
    sourceCount: 6,
    status: "running",
  },
  {
    id: "shared-2",
    title: "Competitor notes distilled into strategy",
    updatedAt: isoHoursAgo(1),
    sourceCount: 4,
    status: "ready",
  },
];

export const privateChats: ChatItem[] = [
  {
    id: "private-1",
    title: "What should we ship in the notebook chat MVP?",
    updatedAt: new Date().toISOString(),
    sourceCount: 5,
    status: "ready",
  },
  {
    id: "private-2",
    title: "Draft product positioning against NotebookLM",
    updatedAt: isoHoursAgo(24),
    sourceCount: 3,
    status: "attention",
  },
  {
    id: "private-3",
    title: "Meeting synthesis for team review",
    updatedAt: isoHoursAgo(48),
    sourceCount: 2,
    status: "ready",
  },
];

export const archivedChats: ChatItem[] = [
  {
    id: "archived-1",
    title: "Legacy IA exploration",
    updatedAt: isoHoursAgo(24 * 7),
    sourceCount: 2,
    status: "ready",
  },
];

export const messages: UIMessage[] = [
  {
    id: "m1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Give me a quick summary of the selected sources.",
      },
    ],
  },
  {
    id: "m2",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `Here is the short version:\n\n- The workspace should feel source-first, not chat-first.\n- The chat area needs a cleaner message flow with grounded answers.\n- Sources should stay visible and easy to attach while asking questions.\n\nIf you want, I can turn this into a product brief next.`,
      },
    ],
  },
  {
    id: "m3",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Now make it more actionable for the design team.",
      },
    ],
  },
  {
    id: "m4",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `For design, focus on three things first:\n\n1. Make user messages clearly right-aligned with a filled bubble.\n2. Keep assistant replies left-aligned with lightweight source references.\n3. Make the composer feel stable in both new chat and active thread states.`,
      },
    ],
  },
];

export const librarySources: SourceItem[] = [
  {
    id: "source-1",
    title: "chat-workspace-ui-design.zh-CN.md",
    type: "DOC",
    status: "Indexed",
    meta: "Updated 20 min ago · 14 sections",
    folder: "Design",
  },
  {
    id: "source-2",
    title: "design-system.zh-CN.md",
    type: "DOC",
    status: "Indexed",
    meta: "Tokens and layout rules",
    folder: "Design",
  },
  {
    id: "source-6",
    title: "component-library-audit.pdf",
    type: "PDF",
    status: "Indexed",
    meta: "62 pages · Uploaded 2 days ago",
    folder: "Design",
  },
  {
    id: "source-3",
    title: "Surfsense reference screenshots",
    type: "WEB",
    status: "Needs review",
    meta: "Imported from benchmark board",
    folder: "Research",
  },
  {
    id: "source-4",
    title: "NotebookLM interaction notes",
    type: "NOTE",
    status: "Syncing",
    meta: "Connector sync running",
    folder: "Research",
  },
  {
    id: "source-5",
    title: "team-first-final-architecture.md",
    type: "DOC",
    status: "Indexed",
    meta: "Architecture boundary reference",
    folder: "Research",
  },
  {
    id: "source-7",
    title: "product-strategy-2025.pdf",
    type: "PDF",
    status: "Indexed",
    meta: "Uploaded last week · 18 pages",
  },
];

export const inChatSources: SourceItem[] = [
  {
    id: "source-1",
    title: "chat-workspace-ui-design.zh-CN.md",
    type: "DOC",
    status: "Indexed",
    meta: "Updated 20 min ago · 14 sections",
  },
  {
    id: "source-2",
    title: "design-system.zh-CN.md",
    type: "DOC",
    status: "Indexed",
    meta: "Tokens and layout rules",
  },
  {
    id: "source-5",
    title: "team-first-final-architecture.md",
    type: "DOC",
    status: "Indexed",
    meta: "Architecture boundary reference",
  },
];

export const citations: CitationItem[] = [
  {
    id: "citation-1",
    sourceTitle: "chat-workspace-ui-design.zh-CN.md",
    messageLabel: "Reply 02",
    excerpt:
      "Layout structure: Workspace Rail + Chat Sidebar + Chat Canvas + Context Hub.",
  },
  {
    id: "citation-2",
    sourceTitle: "design-system.zh-CN.md",
    messageLabel: "Reply 02",
    excerpt:
      "Chat Sidebar 280px (shrink to 240px), Context Hub 400px (expand to 620px).",
  },
  {
    id: "citation-3",
    sourceTitle: "team-first-final-architecture.md",
    messageLabel: "Reply 04",
    excerpt:
      "Workspace switching is a shell component behavior, not a dedicated route.",
  },
];

export const connectors: ConnectorItem[] = [
  {
    id: "connector-1",
    name: "Google Drive",
    status: "Connected",
    meta: "Last sync 8 min ago",
  },
  {
    id: "connector-2",
    name: "Notion",
    status: "Syncing",
    meta: "12 pages updating",
  },
  {
    id: "connector-3",
    name: "Web clipper",
    status: "Action needed",
    meta: "Re-authentication required",
  },
];

export const composerChips = [
  "Summarize",
  "Extract insights",
  "Generate report",
  "Build deck",
];

export const sourceChips = ["UI design", "Design system", "Architecture"];
