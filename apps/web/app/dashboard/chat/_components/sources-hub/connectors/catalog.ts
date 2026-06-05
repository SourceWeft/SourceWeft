import {
  BookOpen,
  CalendarDays,
  CircleAlert,
  Cloud,
  Database,
  FileText,
  Globe2,
  HardDrive,
  Link2,
  Mail,
  MessageCircle,
  MessageSquare,
  Music2,
  Search,
  SquareCheckBig,
  Table2,
} from "lucide-react";
import type { ConnectorCatalogCategory, ConnectorCatalogItem } from "./types";

function oauthCatalogItem(
  item: Omit<
    ConnectorCatalogItem,
    | "authKind"
    | "connectMode"
    | "isIndexable"
    | "statusKind"
    | "supportsActions"
    | "supportsPeriodicSync"
    | "supportsWebhook"
  > &
    Partial<
      Pick<
        ConnectorCatalogItem,
        | "isIndexable"
        | "statusKind"
        | "supportsActions"
        | "supportsPeriodicSync"
        | "supportsWebhook"
      >
    >,
): ConnectorCatalogItem {
  return {
    ...item,
    authKind: "oauth",
    connectMode: item.id === "notion" ? "oauth_connector" : "coming_soon",
    isIndexable: item.isIndexable ?? true,
    statusKind:
      item.statusKind ?? (item.id === "notion" ? "available" : "coming_soon"),
    supportsActions: item.supportsActions ?? false,
    supportsPeriodicSync: item.supportsPeriodicSync ?? true,
    supportsWebhook: item.supportsWebhook ?? false,
  };
}

function apiCatalogItem(
  item: Omit<
    ConnectorCatalogItem,
    | "authKind"
    | "connectMode"
    | "isIndexable"
    | "statusKind"
    | "supportsActions"
    | "supportsPeriodicSync"
    | "supportsWebhook"
  > &
    Partial<
      Pick<
        ConnectorCatalogItem,
        | "isIndexable"
        | "statusKind"
        | "supportsActions"
        | "supportsPeriodicSync"
        | "supportsWebhook"
      >
    >,
): ConnectorCatalogItem {
  return {
    ...item,
    authKind: "api_key",
    connectMode: "coming_soon",
    isIndexable: item.isIndexable ?? false,
    statusKind: item.statusKind ?? "non_indexable",
    supportsActions: item.supportsActions ?? false,
    supportsPeriodicSync: item.supportsPeriodicSync ?? false,
    supportsWebhook: item.supportsWebhook ?? false,
  };
}

export const connectorCatalog: ConnectorCatalogItem[] = [
  oauthCatalogItem({
    id: "notion",
    name: "Notion",
    category: "Knowledge & Docs",
    description: "Sync pages, comments, webhooks, and write approved outputs.",
    capabilities: ["Pages", "Webhooks", "Write actions"],
    postOAuthMode: "auto_create",
    icon: FileText,
    logoIconName: "notion",
    logoIconTone: "brand",
    supportsActions: true,
    supportsWebhook: true,
    webhookSupportNote:
      "Notion API version 2026-03-11. Page events use targeted sync; data source events rediscover currently shared pages.",
  }),
  oauthCatalogItem({
    id: "confluence",
    name: "Confluence",
    category: "Knowledge & Docs",
    description: "Index spaces, pages, comments, and team knowledge.",
    capabilities: ["Spaces", "Pages", "Comments"],
    icon: BookOpen,
  }),
  oauthCatalogItem({
    id: "bookstack",
    name: "BookStack",
    category: "Knowledge & Docs",
    description: "Sync shelves, books, chapters, and pages.",
    capabilities: ["Books", "Chapters", "Pages"],
    icon: BookOpen,
  }),
  oauthCatalogItem({
    id: "google-drive",
    name: "Google Drive",
    category: "File Storage",
    description: "Search and sync Drive files from shared workspaces.",
    capabilities: ["Files", "Folders", "Permissions"],
    icon: HardDrive,
  }),
  oauthCatalogItem({
    id: "onedrive",
    name: "OneDrive",
    category: "File Storage",
    description: "Bring Microsoft 365 documents into SourceWeft.",
    capabilities: ["Files", "Folders", "Microsoft 365"],
    icon: Cloud,
  }),
  oauthCatalogItem({
    id: "dropbox",
    name: "Dropbox",
    category: "File Storage",
    description: "Sync Dropbox folders and project documents.",
    capabilities: ["Files", "Folders", "Sync"],
    icon: Cloud,
  }),
  oauthCatalogItem({
    id: "gmail",
    name: "Gmail",
    category: "Communication",
    description: "Search, read, draft, and send approved emails.",
    capabilities: ["Mail", "Drafts", "Actions"],
    icon: Mail,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "slack",
    name: "Slack",
    category: "Communication",
    description: "Index channels and route approved workspace updates.",
    capabilities: ["Messages", "Channels", "Actions"],
    icon: MessageSquare,
    supportsActions: true,
    supportsWebhook: true,
  }),
  oauthCatalogItem({
    id: "microsoft-teams",
    name: "Microsoft Teams",
    category: "Communication",
    description: "Sync chats, channels, meetings, and collaboration context.",
    capabilities: ["Channels", "Chats", "Meetings"],
    icon: MessageCircle,
  }),
  oauthCatalogItem({
    id: "discord",
    name: "Discord",
    category: "Communication",
    description: "Index server channels and community conversations.",
    capabilities: ["Servers", "Channels", "Messages"],
    icon: MessageSquare,
  }),
  oauthCatalogItem({
    id: "linear",
    name: "Linear",
    category: "Projects & Data",
    description: "Search, read, and manage issues and projects.",
    capabilities: ["Issues", "Projects", "Actions"],
    icon: CircleAlert,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "github",
    name: "GitHub",
    category: "Projects & Data",
    description:
      "Connect repositories, issues, pull requests, and discussions.",
    capabilities: ["Repos", "Issues", "Pull requests"],
    icon: Database,
    supportsActions: true,
    supportsWebhook: true,
  }),
  oauthCatalogItem({
    id: "jira",
    name: "Jira",
    category: "Projects & Data",
    description: "Sync issues, projects, epics, and sprint context.",
    capabilities: ["Issues", "Projects", "Sprints"],
    icon: CircleAlert,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "clickup",
    name: "ClickUp",
    category: "Projects & Data",
    description: "Bring tasks, docs, and project status into SourceWeft.",
    capabilities: ["Tasks", "Docs", "Projects"],
    icon: SquareCheckBig,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "airtable",
    name: "Airtable",
    category: "Projects & Data",
    description: "Browse bases, tables, records, and structured knowledge.",
    capabilities: ["Tables", "Records", "Query"],
    icon: Table2,
  }),
  oauthCatalogItem({
    id: "google-calendar",
    name: "Google Calendar",
    category: "Projects & Data",
    description: "Search and manage calendar context and events.",
    capabilities: ["Events", "Schedules", "Actions"],
    icon: CalendarDays,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "luma",
    name: "Luma",
    category: "Projects & Data",
    description: "Sync event pages, attendees, and community programming.",
    capabilities: ["Events", "Guests", "Pages"],
    icon: CalendarDays,
  }),
  oauthCatalogItem({
    id: "circleback",
    name: "Circleback",
    category: "Projects & Data",
    description: "Bring meeting notes and follow-ups into the knowledge graph.",
    capabilities: ["Meetings", "Notes", "Tasks"],
    icon: MessageCircle,
  }),
  oauthCatalogItem({
    id: "wordpress",
    name: "WordPress",
    category: "Publishing",
    description: "Use posts and pages as source material and outputs.",
    capabilities: ["Posts", "Pages", "Publishing"],
    icon: Globe2,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "ghost",
    name: "Ghost",
    category: "Publishing",
    description: "Read and draft publication content with approvals.",
    capabilities: ["Posts", "Drafts", "Publishing"],
    icon: Globe2,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "devto",
    name: "Dev.to",
    category: "Publishing",
    description: "Connect technical articles and publication workflows.",
    capabilities: ["Articles", "Publishing", "Search"],
    icon: FileText,
    supportsActions: true,
  }),
  oauthCatalogItem({
    id: "hashnode",
    name: "Hashnode",
    category: "Publishing",
    description: "Bring developer blogs into the knowledge graph.",
    capabilities: ["Posts", "Blogs", "Publishing"],
    icon: Globe2,
    supportsActions: true,
  }),
  apiCatalogItem({
    id: "webcrawler",
    name: "WebCrawler",
    category: "Knowledge & Docs",
    description: "Crawl public sites and documentation sections.",
    capabilities: ["Crawl", "Sitemap", "Extract"],
    icon: Globe2,
    isIndexable: true,
    statusKind: "indexable",
    supportsPeriodicSync: true,
  }),
  apiCatalogItem({
    id: "youtube",
    name: "YouTube",
    category: "Knowledge & Docs",
    description: "Search videos and channels for research context.",
    capabilities: ["Videos", "Channels", "Search"],
    icon: Music2,
    isIndexable: true,
    statusKind: "indexable",
    supportsPeriodicSync: true,
  }),
  apiCatalogItem({
    id: "searxng",
    name: "SearxNG",
    category: "Knowledge & Docs",
    description: "Use metasearch results as non-indexed research context.",
    capabilities: ["Search", "Web", "Research"],
    icon: Search,
  }),
  apiCatalogItem({
    id: "tavily",
    name: "Tavily",
    category: "Knowledge & Docs",
    description: "Run research-grade web search during agent workflows.",
    capabilities: ["Search", "Answer", "Research"],
    icon: Search,
  }),
  apiCatalogItem({
    id: "linkup",
    name: "Linkup",
    category: "Knowledge & Docs",
    description: "Retrieve fresh web context without adding indexed sources.",
    capabilities: ["Search", "Web", "Context"],
    icon: Link2,
  }),
  apiCatalogItem({
    id: "baidu-search",
    name: "Baidu Search",
    category: "Knowledge & Docs",
    description: "Search Chinese web results for agent context.",
    capabilities: ["Search", "CN web", "Research"],
    icon: Search,
  }),
  oauthCatalogItem({
    id: "elasticsearch",
    name: "Elasticsearch",
    category: "Projects & Data",
    description: "Query enterprise search indices and operational data.",
    capabilities: ["Indices", "Query", "Search"],
    icon: Database,
    isIndexable: false,
    statusKind: "non_indexable",
    supportsPeriodicSync: false,
  }),
];
export const connectorCatalogCategories: ConnectorCatalogCategory[] = [
  "Knowledge & Docs",
  "File Storage",
  "Communication",
  "Projects & Data",
  "Publishing",
];
export const connectorSyncFrequencyOptions = [
  { label: "Manual", value: "manual" },
  { label: "15 min", value: "15" },
  { label: "1 hour", value: "60" },
  { label: "6 hours", value: "360" },
  { label: "12 hours", value: "720" },
  { label: "Daily", value: "1440" },
  { label: "Weekly", value: "10080" },
  { label: "Custom", value: "custom" },
] as const;
export const connectorSyncFrequencyPresetValues = new Set(
  connectorSyncFrequencyOptions
    .map((option) => option.value)
    .filter((value) => value !== "manual" && value !== "custom"),
) as Set<string>;
