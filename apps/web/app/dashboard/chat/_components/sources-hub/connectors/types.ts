import type { LucideIcon } from "lucide-react";
import type {
  ConnectorWebhookConfigResponse,
  ConnectorWebhookEvent,
  SourceConnector,
} from "@sourceweft/sdk";
import type {
  GlobalIconName,
  GlobalIconTone,
} from "@sourceweft/ui-web/components/ui/global-icon";
import { connectorsClient } from "../../../../../../lib/sdk";

export type ConnectorIcon = LucideIcon;

export type ConnectorAccountItem = Awaited<
  ReturnType<typeof connectorsClient.listAccounts>
>["items"][number];

export type ConnectorWebhookEventItem = ConnectorWebhookEvent;
export type ConnectorWebhookConfig = ConnectorWebhookConfigResponse;

export type ConnectorItem = {
  id: string;
  name: string;
  status: "active" | "paused" | "error" | "disabled";
  meta: string;
  raw: SourceConnector;
};

export type ConnectorCatalogCategory = "Knowledge & Docs" | "Communication";

export type ConnectorCatalogItem = {
  id: string;
  name: string;
  category: ConnectorCatalogCategory;
  description: string;
  capabilities: string[];
  postOAuthMode?: "auto_create" | "configure_required";
  isIndexable: boolean;
  supportsPeriodicSync: boolean;
  supportsActions: boolean;
  supportsWebhook: boolean;
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
  | "blocked"
  | "error";

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
