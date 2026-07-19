import type { LucideIcon } from "lucide-react";
import type { SourceConnector } from "@sourceweft/sdk";
import type {
  GlobalIconName,
  GlobalIconTone,
} from "@sourceweft/ui-web/components/ui/global-icon";

export type ConnectorIcon = LucideIcon;

export type ConnectorItem = {
  id: string;
  name: string;
  status: "active" | "paused" | "error" | "disabled";
  meta: string;
  raw: SourceConnector;
};

export type ConnectorCatalogCategory =
  | "Knowledge & Docs"
  | "File Storage"
  | "Communication"
  | "Projects & Data"
  | "Publishing";

export type ConnectorConnectMode = "oauth_connector" | "coming_soon";

export type ConnectorCatalogItem = {
  id: string;
  name: string;
  category: ConnectorCatalogCategory;
  description: string;
  capabilities: string[];
  connectMode: ConnectorConnectMode;
  postOAuthMode?: "auto_create" | "configure_required";
  isIndexable: boolean;
  authKind: "oauth" | "api_key" | "native" | "mcp";
  supportsPeriodicSync: boolean;
  supportsActions: boolean;
  supportsWebhook: boolean;
  statusKind: "available" | "coming_soon" | "non_indexable" | "indexable";
  icon: ConnectorIcon;
  logoIconName?: GlobalIconName;
  logoIconTone?: GlobalIconTone;
  logoSrc?: string;
  webhookSupportNote?: string;
};

export type ConnectorCatalogStatusKind =
  | "available"
  | "connected"
  | "active"
  | "needs_setup"
  | "syncing"
  | "error"
  | "coming_soon";

export type ConnectorCatalogStatus = {
  kind: ConnectorCatalogStatusKind;
  label: string;
  detail: string;
};

export type ConnectorReadinessState = {
  reason: string;
  message: string;
};

export type ConnectorActivityKindFilter = "all" | "sync" | "action" | "webhook";
