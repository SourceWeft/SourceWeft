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
  /** Hidden from the catalog until the backend reports the type as available.
   * Set for connectors that depend on backend rollout registration. */
  requiresBackendRegistration?: boolean;
  /** Add-only connector: there is no account to authorize, and each entry is
   * its own connector, so the card never reads as connected and its action
   * adds another one. `feed_url` asks for a feed URL; `credential` asks for an
   * endpoint, a username and an app password (WebDAV). */
  addMode?: "feed_url" | "credential";
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

/** Outcome of the pre-create feed check: the readiness verdict plus, when the
 * feed was read, its title and item count (both from the check metadata). */
export type FeedCheckResult = ConnectorReadinessState & {
  ready: boolean;
  title: string | null;
  itemCount: number | null;
};

/** A username and app password entered for a `credential` connector. The
 * secret is held only in local dialog state and never persisted anywhere on
 * the client (no query cache, URL or storage). */
export type ConnectorCredentialInputValues = {
  username: string;
  secret: string;
};

/** Outcome of the pre-create credential check (`POST /connectors/check`): the
 * readiness verdict for the entered endpoint and credential. Persists nothing
 * and never echoes the secret. */
export type CredentialCheckResult = ConnectorReadinessState & {
  ready: boolean;
};

/**
 * Per-connector-type facts derived from its manifest (see
 * `connectorsClient.listManifests`): whether the adapter declares any sync
 * resources, and, for a brokered adapter (`auth.kind === "brokered"`), which
 * broker fronts its authorization. A connector type absent from the manifest
 * response, or whose manifest has not loaded yet, has no entry here; callers
 * treat a missing entry the same as today's (indexable, non-brokered) shape.
 */
export type ConnectorManifestInfo = {
  supportsIndexing: boolean;
  broker: string | null;
};

export type ConnectorActivityKindFilter = "all" | "sync" | "action" | "webhook";
