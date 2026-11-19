import {
  BookOpenText,
  Box,
  FileText,
  FolderGit2,
  HardDrive,
  ListChecks,
  Mail,
  SquareKanban,
} from "lucide-react";
import type { ConnectorCatalogCategory, ConnectorCatalogItem } from "./types";

export const connectorCatalog: ConnectorCatalogItem[] = [
  {
    id: "notion",
    name: "Notion",
    category: "Knowledge & Docs",
    description: "Sync pages, comments, webhooks, and write approved outputs.",
    capabilities: ["Pages", "Webhooks", "Write actions"],
    postOAuthMode: "auto_create",
    icon: FileText,
    logoIconName: "notion",
    logoIconTone: "brand",
    isIndexable: true,
    supportsActions: true,
    supportsPeriodicSync: true,
    supportsWebhook: true,
    webhookSupportNote:
      "Notion API version 2026-03-11. Page events use targeted sync; data source events rediscover currently shared pages.",
  },
  {
    id: "gmail",
    name: "Gmail",
    category: "Communication",
    description:
      "Search and read mail, optionally index it, and send reviewed messages.",
    capabilities: ["Search", "Optional indexing", "Approved sending"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    icon: Mail,
    isIndexable: true,
    supportsActions: true,
    supportsPeriodicSync: true,
    supportsWebhook: false,
  },
  {
    id: "google_drive",
    name: "Google Drive",
    category: "Knowledge & Docs",
    description:
      "Pick Drive files to index and keep them in sync on a schedule.",
    capabilities: ["Selected files", "Scheduled sync"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    icon: HardDrive,
    isIndexable: true,
    supportsActions: false,
    supportsPeriodicSync: true,
    supportsWebhook: false,
  },
  {
    id: "dropbox",
    name: "Dropbox",
    category: "Knowledge & Docs",
    description:
      "Choose Dropbox files and folders to index and keep them in sync.",
    capabilities: ["Files & folders", "Scheduled sync"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    icon: Box,
    isIndexable: true,
    supportsActions: false,
    supportsPeriodicSync: true,
    supportsWebhook: false,
  },
  {
    id: "github",
    name: "GitHub",
    category: "Knowledge & Docs",
    description:
      "Let agents search and read issues, pull requests and discussions in the repositories you choose.",
    capabilities: ["Issues & pull requests", "Discussions", "Live search"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    icon: FolderGit2,
    logoIconName: "github",
    logoIconTone: "mono",
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  },
  {
    id: "linear",
    name: "Linear",
    category: "Knowledge & Docs",
    description:
      "Search and read Linear issues and projects from the teams you choose.",
    capabilities: ["Issues & projects", "Live search"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    // No Linear logo file is added yet, so `logoIconName` is omitted and this
    // icon shows instead.
    icon: ListChecks,
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  },
  {
    id: "jira",
    name: "Jira",
    category: "Knowledge & Docs",
    description:
      "Let the agent search and read issues in the Jira projects you choose.",
    capabilities: ["Live search", "Issues & projects"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    icon: SquareKanban,
    // No Atlassian artwork is shipped, so this entry has no logoIconName
    // (unlike Notion/Dropbox's logoIconName/logoIconTone).
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  },
  {
    id: "confluence",
    name: "Confluence",
    category: "Knowledge & Docs",
    description:
      "Let the agent search and read pages in the Confluence spaces and pages you choose.",
    capabilities: ["Live search", "Spaces & pages"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    icon: BookOpenText,
    // No Atlassian artwork is shipped, so this entry has no logoIconName.
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  },
];

// Some connectors ship behind a backend rollout gate; hide each until the API
// registers its type as available.
export function connectorCatalogForAvailableTypes(
  availableConnectorTypes: readonly string[],
): ConnectorCatalogItem[] {
  return connectorCatalog.filter(
    (item) =>
      !item.requiresBackendRegistration ||
      availableConnectorTypes.includes(item.id),
  );
}

// The catalog lists "Optional indexing" statically, but a deployment can run
// a connector type with no sync resources at all (e.g. a tools-only,
// Composio-brokered Gmail). Drop that one chip in that case; every other
// capability still applies. `supportsIndexing` is `undefined` when the
// manifest for this type has not loaded yet, which keeps today's chips.
export function connectorCatalogCapabilities(
  item: ConnectorCatalogItem,
  supportsIndexing: boolean | undefined,
): string[] {
  if (supportsIndexing === false) {
    return item.capabilities.filter(
      (capability) => capability !== "Optional indexing",
    );
  }
  return item.capabilities;
}

export const connectorCatalogCategories: ConnectorCatalogCategory[] = [
  "Knowledge & Docs",
  "Communication",
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
