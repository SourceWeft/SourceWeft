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
  /** Never shown as its own picker card, but still a catalog entry so existing
   * rows of this type resolve their name, icon, readiness copy and rotate
   * dialog. Used for the second connector of a product that ships one card and
   * two backend types: WordPress registers `wordpress` (public) and
   * `wordpress_login`, and the login type is hidden here while the public card
   * creates either one. */
  hiddenInPicker?: boolean;
  /** Add-only connector: there is no account to authorize, and each entry is
   * its own connector, so the card never reads as connected and its action
   * adds another one. `feed_url` asks for a feed URL; `credential` asks for an
   * endpoint, a username and an app password (WebDAV); `login_flow` sends the
   * member to the provider's own browser login and the backend collects the
   * credential (Nextcloud); `api_key` asks for a library ID and a read-only API
   * key (Zotero) or a Ghost site address and Content API key (Ghost, told apart
   * by catalog id); `forum_url` asks for a public forum's address and the
   * categories and topics are chosen after it exists (Discourse); `site_url`
   * asks for a WordPress site address and an access choice (a public site or an
   * Application Password login), which decides which connector type is
   * created. */
  addMode?:
    | "feed_url"
    | "credential"
    | "login_flow"
    | "api_key"
    | "forum_url"
    | "site_url";
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
  /** Adapter-specific facts of the check (Zotero reports `notesAccess`). Only
   * present when the server returned any. */
  metadata?: Record<string, unknown>;
};

/** A readiness check or create for a connector that needs no credential
 * (Discourse), built by that type's dialog: the type and its config. */
export type ForumCheckInput = {
  connectorType: string;
  configJson: Record<string, unknown>;
};

export type ForumAddInput = ForumCheckInput & {
  name: string;
  periodicIndexingEnabled: boolean;
};

/** Outcome of the pre-create forum check: the readiness verdict. A reachable
 * forum with nothing chosen yet reports `ready: false` with the reason
 * `selection_required`, which the dialog treats as success. */
export type ForumCheckResult = ConnectorReadinessState & {
  ready: boolean;
};

/** The access choice in the WordPress add dialog: a public site (the
 * `wordpress` connector, no credential) or an Application Password login (the
 * `wordpress_login` connector, username + secret, self-hosted only). */
export type WordpressAccess = "public" | "login";

/** A readiness check or create for a WordPress site, built by its add dialog.
 * The access choice decides the connector type and whether an Application
 * Password travels with it; the secret lives only in the dialog's local state
 * and is never persisted on the client. `includeUnpublished` applies to the
 * login choice only (drafts and private posts become visible to every member). */
export type SiteCheckInput =
  | {
      access: "public";
      siteUrl: string;
      includeUnpublished: boolean;
    }
  | {
      access: "login";
      siteUrl: string;
      includeUnpublished: boolean;
      credential: ConnectorCredentialInputValues;
    };

/** Outcome of the pre-create WordPress site check: the readiness verdict. An
 * empty selection is ready (it means every published post and page), so a
 * reachable site reports `ready: true`. */
export type SiteCheckResult = ConnectorReadinessState & { ready: boolean };

export type SiteAddInput = SiteCheckInput & {
  name: string;
  periodicIndexingEnabled: boolean;
};

/** A readiness check for a Ghost site, built by its add dialog: the API URL
 * and the Content API key. The key lives only in the dialog's local state and
 * the request body; it is never persisted on the client. */
export type GhostCheckInput = {
  siteUrl: string;
  secret: string;
};

/** Outcome of the pre-create Ghost check: the readiness verdict. An empty
 * selection is ready (it means every published post and page). */
export type GhostCheckResult = ConnectorReadinessState & { ready: boolean };

export type GhostAddInput = GhostCheckInput & {
  name: string;
  periodicIndexingEnabled: boolean;
};

/** The WebDAV credential check input: an endpoint and its username/password. */
export type WebdavCredentialCheckInput = {
  endpoint: string;
  username: string;
  secret: string;
};

/** A credential check for any connector type, built by that type's dialog: the
 * connector's config and the credential to test. */
export type GenericCredentialCheckInput = {
  connectorType: string;
  configJson: Record<string, unknown>;
  credential: ConnectorCredentialInputValues;
};

/** The WebDAV create input: endpoint, credential and the folders to index. */
export type WebdavCredentialAddInput = {
  name: string;
  endpoint: string;
  username: string;
  secret: string;
  roots: string[];
  periodicIndexingEnabled: boolean;
};

/** A create for any credential connector type, built by that type's dialog. */
export type GenericCredentialAddInput = GenericCredentialCheckInput & {
  name: string;
  periodicIndexingEnabled: boolean;
};

export type CredentialCheckInput =
  WebdavCredentialCheckInput | GenericCredentialCheckInput;
export type CredentialAddInput =
  WebdavCredentialAddInput | GenericCredentialAddInput;

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
