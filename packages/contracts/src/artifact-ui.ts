/**
 * Artifact UI registration contract.
 *
 * A capability that produces an artifact owns *both* of the surfaces that show
 * it: the block inside the message stream (dispatched by the capability's
 * `renderAs` token, and reached while a tool call is still running) and the
 * right-hand preview panel (dispatched by a stored artifact row, which may have
 * no tool call at all). The two surfaces take different inputs, so they stay two
 * indexes — but they are declared once, by one owner, in one `ArtifactUiModule`.
 *
 * This file is a leaf subpath export (`@sourceweft/contracts/artifact-ui`). Only
 * React hosts import it, so the `react` types it references never enter the type
 * graph of server-side consumers that import other contract subpaths.
 */
import type { ComponentType, ReactNode } from "react";

// ---------------------------------------------------------------------------
// Shared read-only views
// ---------------------------------------------------------------------------

/**
 * The read-only slice of a tool call an artifact renderer may look at.
 *
 * Deliberately narrower than the host's full tool-call record (no trace
 * ordering, no approval bookkeeping). `latencyMs` is included because the
 * host's own block components are typed against a record that requires it, and
 * `ComponentType<ArtifactBlockProps>` is contravariant in its props — dropping
 * it would make the host's existing components unassignable to this contract.
 */
export type ToolCallView = {
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly output: unknown;
  readonly latencyMs: number | null;
  readonly status: "running" | "approval_requested" | "completed" | "error";
  readonly error: string | null;
};

export type ArtifactLifecycleStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "archived";

export type ArtifactFileCapabilities = {
  canOpenFile: boolean;
  canDownloadFile: boolean;
  canPreviewInline: boolean;
  canRenderClientSide: boolean;
};

/**
 * A stored artifact row as the chat surfaces carry it.
 *
 * `artifactType` is an opaque string on purpose: which types exist is owned by
 * the capability packages, and narrowing it here would force every new
 * capability to edit this shared file.
 */
export type ArtifactPreviewRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  threadId: string | null;
  artifactType: string;
  status: ArtifactLifecycleStatus;
  title: string | null;
  promptText: string | null;
  payloadJson: Record<string, unknown>;
  storageBucket: string | null;
  storageKey: string | null;
  previewStorageKey: string | null;
  previewMetadataJson: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  previewUrl: string | null;
  capabilities: ArtifactFileCapabilities;
};

/** The live status of an artifact a tool call is still producing. */
export type ArtifactStatusSnapshot = {
  artifactType: string;
  capabilities: ArtifactFileCapabilities;
  completedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  id: string;
  payloadJson: Record<string, unknown>;
  previewUrl: string | null;
  promptText: string | null;
  previewMetadataJson: Record<string, unknown>;
  previewStorageKey: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  status: ArtifactLifecycleStatus;
  teamId: string;
  threadId: string | null;
  title: string | null;
  updatedAt: string;
  workspaceId: string;
};

// ---------------------------------------------------------------------------
// Message-stream path
// ---------------------------------------------------------------------------

export type ArtifactBlockProps = {
  toolCall: ToolCallView | undefined;
  workspaceId?: string | null;
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
};

// ---------------------------------------------------------------------------
// Preview-panel path
// ---------------------------------------------------------------------------

export type ArtifactPreviewLayout = "page" | "panel";

/**
 * The artifact-row fields a preview may branch on.
 *
 * Kept to what a preview genuinely reads. `errorMessage` is here because a
 * long-running deliverable can fail *after* its row exists, and the panel's own
 * failure chrome is bypassed once a capability claims the type — so the owner
 * has to be able to word the failure itself.
 */
export type ArtifactPreviewArtifactView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly artifactType: string;
  readonly status: string;
  readonly errorMessage: string | null;
};

export type ArtifactPreviewContext = {
  readonly artifact: ArtifactPreviewArtifactView;
  readonly downloadUrl: string | null;
  readonly layout: ArtifactPreviewLayout;
  readonly pageUrl: string | null;
  readonly payload: Record<string, unknown>;
  readonly proxyFileUrl: string | null;
  readonly title: string;
  readonly workspaceId?: string | null;
};

export type ArtifactPreviewResult = {
  /** Stable id for diagnostics and host tests. */
  readonly id: string;
  readonly content: ReactNode;
  /** The preview owns downloading; the host chrome must not offer its own. */
  readonly blocksDefaultDownload?: boolean;
  /** The preview owns opening; the host chrome must not offer its own. */
  readonly blocksDefaultOpen?: boolean;
};

// ---------------------------------------------------------------------------
// Host facilities
// ---------------------------------------------------------------------------

export type ArtifactUrlInput = {
  artifactId?: string | null;
  fallbackUrl?: string | null;
  workspaceId?: string | null;
};

export type ArtifactPreviewImageInput = {
  artifactId?: string | null;
  previewMetadataJson?: unknown;
  previewStorageKey?: string | null;
  workspaceId?: string | null;
};

export type ArtifactSnapshotQuery = {
  artifactSnapshot?: ArtifactStatusSnapshot;
  enabled?: boolean;
  toolCallOutput?: unknown;
  workspaceId?: string | null;
};

export type ArtifactSnapshotQueryResult = {
  artifactId: string | null | undefined;
  snapshot: ArtifactStatusSnapshot | undefined;
};

/**
 * The app-shell facilities an artifact renderer is allowed to reach.
 *
 * Capability UI must not import app internals (API base URL, route builders,
 * data clients), so the host injects them once. Note what is *not* here:
 * `apiBaseUrl` never appears, because it only ever existed to build artifact
 * URLs and is fully encapsulated behind the two resolvers below.
 */
export type ArtifactRenderHost = {
  /**
   * Reads a scalar field out of a tool call's output, whichever transport
   * shape it arrived in (structured record, JSON string, `key: value` text).
   * Generic across capabilities: what the *keys* mean stays with the owner.
   */
  readonly readToolOutputField: (output: unknown, key: string) => string | null;
  /**
   * The same lookup as `readToolOutputField`, but handing back the raw value
   * instead of its string rendering. Needed by owners whose output vocabulary
   * includes non-string scalars (a boolean flag, a count) that would otherwise
   * be flattened; the transport walk is still the host's, the key names are
   * still the owner's.
   */
  readonly readToolOutputValue: (output: unknown, key: string) => unknown;
  /** Browser-visible page URL for an artifact. */
  readonly resolveArtifactPageUrl: (input: ArtifactUrlInput) => string | null;
  /**
   * Thumbnail URL for an artifact row, or null when the row carries no preview
   * image. Pure route construction over the generic preview-image columns — the
   * *reason* a row has a thumbnail is the capability's business, the URL shape
   * is the app's.
   */
  readonly resolveArtifactPreviewImageUrl: (
    input: ArtifactPreviewImageInput,
  ) => string | null;
  /**
   * Absolutizes a backend-relative (`/v1/…`) asset path against the API origin;
   * anything else is returned untouched. Deliberately *not* the artifact-route
   * rewriter above: per-asset URLs a capability hands to a media element must
   * reach the API directly rather than being folded into an artifact file route.
   */
  readonly resolveApiAssetUrl: (value: string) => string;
  /** Proxied file URL for an artifact; `download` forces attachment delivery. */
  readonly resolveArtifactFileUrl: (
    input: ArtifactUrlInput & { download?: boolean },
  ) => string | null;
  /**
   * Reconciles a tool call's artifact against the stored row. A React hook —
   * only legal from a component's render. Injected because it reaches the
   * host's data client.
   */
  readonly useArtifactSnapshot: (
    input: ArtifactSnapshotQuery,
  ) => ArtifactSnapshotQueryResult;
};

let currentHost: ArtifactRenderHost | null = null;

/** Installed once by the app shell, before any artifact UI renders. */
export function configureArtifactRenderHost(host: ArtifactRenderHost) {
  currentHost = host;
}

export function artifactRenderHost(): ArtifactRenderHost {
  if (!currentHost) {
    throw new Error(
      "Artifact render host is not configured. Call configureArtifactRenderHost() from the app shell.",
    );
  }
  return currentHost;
}

// ---------------------------------------------------------------------------
// The registration unit
// ---------------------------------------------------------------------------

/**
 * One capability's artifact UI, mounted on both indexes at once.
 *
 * A capability supplies whichever surfaces it has: a tool-call-driven block, a
 * stored-row-driven preview, or both. Variant selection and payload decoding
 * live inside `preview()` — the party that wrote the payload is the only one
 * qualified to read it, so the generic layer never sniffs payload shapes.
 */
export type ArtifactUiModule = {
  readonly id: string;
  /**
   * Message-stream key. The same opaque token as
   * `AgentToolPresentation.renderAs`; the generic renderer only matches it.
   */
  readonly renderAs?: string;
  /** Preview-panel key: the `artifactType` values this capability owns. */
  readonly artifactTypes?: readonly string[];
  readonly Block?: ComponentType<ArtifactBlockProps>;
  preview?(context: ArtifactPreviewContext): ArtifactPreviewResult | null;
};
