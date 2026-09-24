import { FileText } from "lucide-react";
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
];

export const connectorCatalogCategories: ConnectorCatalogCategory[] = [
  "Knowledge & Docs",
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
