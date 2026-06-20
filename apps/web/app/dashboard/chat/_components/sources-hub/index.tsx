"use client";

import {
  type ComponentType,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  Loader2,
  Music2,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Presentation,
  Play,
  Power,
  PowerOff,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  SquareCheckBig,
  SquareMinus,
  Trash2,
  Upload,
  Webhook,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  HttpClientError,
  type CapabilityCatalogCommand,
  type ListCapabilityCatalogResponse,
  type ConnectorWebhookEvent,
  type ConnectorActivityItem,
  type ConnectorWebhookConfigResponse,
  type McpToolSelection,
  type SourceConnector,
  type WorkspaceMcpInstall,
} from "@sourceweft/sdk";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import {
  GlobalIcon,
  type GlobalIconName,
  type GlobalIconTone,
} from "@sourceweft/ui-web/components/ui/global-icon";
import { RawImage } from "../../../../_components/raw-image";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  Button,
  buttonVariants,
} from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@sourceweft/ui-web/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { Separator } from "@sourceweft/ui-web/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  apiBaseUrl,
  connectorsClient,
  contentClient,
} from "../../../../../lib/sdk";
import {
  CONNECTOR_OAUTH_CHANNEL,
  CONNECTOR_OAUTH_STORAGE_KEY,
  parseConnectorOAuthCompletionMessage,
  type ConnectorOAuthCompletionMessage,
} from "../../../connectors/oauth/_components/oauth-messaging";
import { McpIcon, SkillIcon } from "../../../_components/dashboard-icons";
import { SkillsGallery } from "../../../skills/_components/skills-gallery";
import type { CitationRecord } from "../chat-canvas";
import { SourcePreviewPanel } from "../source-preview-panel";
import { expandSelectedSources, type SourceItem } from "../source-types";
import { WorkfileContentViewer } from "../workfile-content-viewer";
import {
  artifactMatchesQuery,
  artifactPreviewImageMetadata,
  artifactTitle,
  artifactTypeLabel,
  resolveArtifactPreviewImageProxyUrl,
  resolveArtifactProxyFileUrl,
} from "./artifacts";
import { cloneItems, getThreadWorkfilesCacheKey } from "./cache";
import {
  connectorCatalog,
  connectorCatalogCategories,
  connectorSyncFrequencyOptions,
  connectorSyncFrequencyPresetValues,
} from "./connectors/catalog";
import type {
  ConnectorCatalogItem,
  ConnectorCatalogStatus,
  ConnectorCatalogStatusKind,
  ConnectorIcon,
  ConnectorItem,
  ConnectorReadinessState,
} from "./connectors/types";
import {
  buildSourceSelectionStateMap,
  buildSourceTree,
  buildSourceTreeFromIndex,
  buildSourceTreeIndex,
  collectSelectableSourceIds,
  collectTreeIds,
  countTreeNodes,
  findNodePath,
  flattenVisibleSourceTree,
  isSelectableSource,
  isSyncingSource,
  normalizeSourceSelectionFromTree,
  toggleSourceSelectionInTree,
  type SourceSelectionState,
  type SourceTreeIndex,
  type SourceTreeNode,
} from "./source-tree";
import {
  createHubTabStorage,
  persistSourceTreeExpansion as persistSourceTreeExpansionStorage,
  readStoredSourceTreeExpansion as readStoredSourceTreeExpansionStorage,
} from "./storage";
import {
  ACTIVE_SYNC_RUN_POLL_MS,
  CONNECTOR_SYNC_RUN_CHANNEL_PREFIX,
  SYNC_RUN_LEADER_CHECK_MS,
  SYNC_RUN_LEADER_ELECTION_MS,
  SYNC_RUN_LEADER_HEARTBEAT_MS,
  type ConnectorSyncRunLeaderCandidate,
  getConnectorSyncRunPollDecision,
  selectConnectorSyncRunLeader,
} from "./sync-run-polling";
import { TypeBadge } from "./type-badge";
import type { ArtifactListItem } from "./types";
import { useVirtualRows } from "./use-virtual-rows";
import {
  getCachedWorkspaceHubValue,
  setCachedWorkspaceHubValue,
} from "./workspace-hub-cache";
import { resolveWorkspaceSourceHydration } from "./source-refresh-state";

export { ArtifactPreviewPanel } from "./artifact-preview-panel";
export type { ArtifactListItem } from "./types";

const tabs = [
  "Sources",
  "Workfiles",
  "Artifacts",
  "Connectors",
  "Skills",
  "MCP",
] as const;
const addTabs = ["File", "URL", "Text"] as const;
const HUB_ACTIVE_TAB_STORAGE_KEY = "chat:sources-hub:active-tab:v1";
const SOURCE_TREE_EXPANSION_STORAGE_PREFIX = "chat:sources-hub:source-tree:v1";
const MAX_FILES = 20;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const SOURCE_TREE_INDENT_PX = 10;
const SOURCE_TREE_VIRTUALIZE_THRESHOLD = 400;
const SOURCE_TREE_ROW_HEIGHT_PX = 40;
const SOURCE_TREE_OVERSCAN_ROWS = 12;
const SOURCE_SYNC_UPDATED_AFTER_OVERLAP_MS = 1000;
const ACTIVE_SYNC_RUN_TABS = new Set<HubTab>(["Sources", "Connectors"]);
const CONNECTOR_OAUTH_URL_PARAMS = [
  "connector_oauth",
  "connector_type",
  "account_id",
  "workspace_id",
  "error",
] as const;
const SOURCE_FILE_EXTENSIONS = [
  "txt",
  "text",
  "md",
  "markdown",
  "mdx",
  "rst",
  "adoc",
  "asciidoc",
  "org",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "xml",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "svg",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "java",
  "kt",
  "scala",
  "c",
  "h",
  "cpp",
  "cxx",
  "cc",
  "hpp",
  "cs",
  "go",
  "rs",
  "rb",
  "php",
  "lua",
  "swift",
  "r",
  "jl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "bat",
  "cmd",
  "ps1",
  "sql",
  "graphql",
  "gql",
  "tex",
  "bib",
  "log",
  "vue",
  "svelte",
  "astro",
  "tf",
  "hcl",
  "proto",
  "env",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "dockerfile",
  "makefile",
  "cmake",
  "tsv",
  "csv",
  "srt",
  "pdf",
  "doc",
  "docx",
  "pptx",
  "epub",
  "avif",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "gif",
  "flac",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "ogg",
  "wav",
  "webm",
] as const;
const SOURCE_FILE_ACCEPT = SOURCE_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(
  ",",
);
const SOURCE_FILE_EXTENSION_SET = new Set<string>(SOURCE_FILE_EXTENSIONS);
const disabledConnectorIconButtonClass =
  "disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

type HubTab = (typeof tabs)[number] | "Citations";
type AddTab = (typeof addTabs)[number];
const hubTabStorage = createHubTabStorage<HubTab>({
  allowedTabs: [...tabs, "Citations"],
  defaultTab: "Sources",
  storageKey: HUB_ACTIVE_TAB_STORAGE_KEY,
});

const readStoredHubTab = hubTabStorage.readStoredHubTab;
const persistHubTab = hubTabStorage.persistHubTab;
const getLastHubActiveTab = hubTabStorage.getLastHubActiveTab;

function readStoredSourceTreeExpansion(workspaceId?: string | null) {
  return readStoredSourceTreeExpansionStorage(
    SOURCE_TREE_EXPANSION_STORAGE_PREFIX,
    workspaceId,
  );
}

function persistSourceTreeExpansion(input: {
  workspaceId?: string | null;
  expandedDirectoryIds: Set<string>;
  userCollapsedDirectoryIds: Set<string>;
}) {
  persistSourceTreeExpansionStorage({
    ...input,
    storagePrefix: SOURCE_TREE_EXPANSION_STORAGE_PREFIX,
  });
}

type SourceApiRecord = Awaited<
  ReturnType<typeof contentClient.listSources>
>["items"][number];
type CitationScope = "current" | "thread";
type ActiveConnectorSyncRun = {
  connectorId: string;
  discoveredCount: number;
  indexedCount: number;
  failedCount: number;
  lastSourceUpdatedAt: string | null;
  hasFinalRefreshed: boolean;
};
type WorkfileListItem = Awaited<
  ReturnType<typeof contentClient.listWorkingFiles>
>["items"][number];
type WorkfileDetail = Awaited<
  ReturnType<typeof contentClient.getWorkingFile>
>["file"];
type ConnectorAccountItem = Awaited<
  ReturnType<typeof connectorsClient.listAccounts>
>["items"][number];
type WorkspaceConnectorSyncRunsResult = Awaited<
  ReturnType<typeof connectorsClient.listWorkspaceSyncRuns>
>;
type ConnectorSyncRunBroadcastMessage =
  | {
      type: "hello" | "leader-heartbeat";
      tabId: string;
      visible: boolean;
      sentAt: number;
    }
  | {
      type: "sync-runs-result";
      tabId: string;
      sentAt: number;
      result: WorkspaceConnectorSyncRunsResult;
    }
  | {
      type: "sync-runs-wake";
      tabId: string;
      sentAt: number;
    };

const workspaceArtifactsCache = new Map<string, ArtifactListItem[]>();
const workspaceArtifactsCursorCache = new Map<string, string | null>();
const threadWorkfilesCache = new Map<string, WorkfileListItem[]>();
const WORKSPACE_ARTIFACTS_CACHE_BUCKET = "artifacts";
const WORKSPACE_CONNECTORS_CACHE_BUCKET = "connectors";
const WORKSPACE_MCP_CACHE_BUCKET = "mcp";

type WorkspaceArtifactsCacheValue = {
  items: ArtifactListItem[];
  nextCursor: string | null;
};

type WorkspaceConnectorsCacheValue = {
  accounts: ConnectorAccountItem[];
  connectors: ConnectorItem[];
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
  webhookEventsById: Record<string, ConnectorWebhookEventItem[]>;
};

type WorkspaceMcpCacheValue = {
  installs: WorkspaceMcpInstall[];
};

function cloneArtifactItems(items: ArtifactListItem[]) {
  return cloneItems(items);
}

function cloneWorkfileItems(items: WorkfileListItem[]) {
  return cloneItems(items);
}

type DisplayCitationItem = {
  id: string;
  sourceTitle: string;
  messageLabel: string;
  excerpt: string;
  citationRecord: CitationRecord;
  messageId?: string;
};

type ConnectorWebhookEventItem = ConnectorWebhookEvent;
type ConnectorWebhookConfig = ConnectorWebhookConfigResponse;
const syncReadinessUiByReason: Record<
  string,
  {
    summary: string;
    suppressWebhookSetup?: boolean;
  }
> = {
  notion_no_pages: {
    summary: "Connected · No pages shared",
    suppressWebhookSetup: true,
  },
};
type ManageConnectorsTab = "all" | "active";
type ConnectorSettingsTab =
  | "overview"
  | "configuration"
  | "sync"
  | "actions"
  | "webhooks"
  | "danger";
type ConnectorActivityKindFilter = "all" | "sync" | "action" | "webhook";

export type ThreadCitationRecord = {
  citation: CitationRecord;
  id: string;
  messageId: string;
  messageLabel: string;
};

type CitationOpenContext = {
  messageId?: string;
};

const searchPlaceholders: Record<HubTab, string> = {
  Sources: "Search sources...",
  Workfiles: "Search workfiles...",
  Artifacts: "Search artifacts...",
  Skills: "Search installed skills...",
  MCP: "Search MCP tools...",
  Citations: "Search citations...",
  Connectors: "Search connectors...",
};

const searchScopeLabels: Record<HubTab, string> = {
  Sources: "Sources",
  Workfiles: "Workfiles",
  Artifacts: "Artifacts",
  Skills: "Skills",
  MCP: "MCP",
  Citations: "Citations",
  Connectors: "Connectors",
};

export type HubSkillItem = {
  id: string;
  workspaceSkillId?: string;
  catalogId: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  sourceType: "builtin" | "workspace_custom" | "team_custom";
  version: string;
  enabled?: boolean;
  hasReadme: boolean;
  tools?: string[];
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof HttpClientError) {
    return error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}

function isConnectorAlreadyHandledError(error: unknown) {
  return (
    error instanceof HttpClientError &&
    (error.code === "CONNECTOR_ALREADY_EXISTS" ||
      error.code === "CONNECTOR_OAUTH_ACCOUNT_IN_USE")
  );
}

function createConnectorOAuthMessageId(input: {
  workspaceId: string;
  connectorType: string;
  accountId: string | null;
  status: "success" | "error";
}) {
  return [
    "url",
    input.workspaceId,
    input.connectorType,
    input.accountId ?? "none",
    input.status,
  ].join(":");
}

function readConnectorOAuthCompletionFromUrl(): ConnectorOAuthCompletionMessage | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const status = url.searchParams.get("connector_oauth");
  if (status !== "success" && status !== "error") return null;

  const workspaceId = url.searchParams.get("workspace_id") ?? "";
  const connectorType = url.searchParams.get("connector_type") ?? "";
  const accountId = url.searchParams.get("account_id");
  return {
    id: createConnectorOAuthMessageId({
      workspaceId,
      connectorType,
      accountId,
      status,
    }),
    workspaceId,
    connectorType,
    accountId,
    status,
    error:
      status === "error"
        ? (url.searchParams.get("error") ??
          "Connector authorization did not complete.")
        : null,
    createdAt: new Date().toISOString(),
  };
}

function clearConnectorOAuthCompletionFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of CONNECTOR_OAUTH_URL_PARAMS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function apiStatusToSourceStatus(status: string): SourceItem["status"] {
  if (status === "indexed") return "Indexed";
  if (status === "processing" || status === "queued") return "Syncing";
  if (status === "failed") return "Failed";
  return "Needs review";
}

function apiTypeToSourceType(
  sourceType: string,
  mimeType: string | null,
): SourceItem["type"] {
  if (sourceType === "directory") return "DIR";
  if (sourceType === "web_url" || sourceType === "youtube") return "WEB";
  if (sourceType === "note") return "NOTE";
  if (mimeType?.includes("pdf")) return "PDF";
  if (mimeType?.startsWith("image/")) return "IMG";
  if (mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) {
    return "AUDIO";
  }
  if (mimeType?.includes("csv")) return "CSV";
  if (mimeType?.includes("json")) return "JSON";
  if (mimeType?.startsWith("text/")) return "TEXT";
  return "DOC";
}

function getUploadFileExtension(fileName: string) {
  const baseName = fileName.split(/[\\/]/).at(-1)?.trim().toLowerCase() ?? "";
  if (!baseName) return null;
  if (baseName === "dockerfile" || baseName.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (baseName === "makefile" || baseName.startsWith("makefile.")) {
    return "makefile";
  }
  if (baseName.startsWith(".env")) return "env";
  if (
    baseName.startsWith(".") &&
    SOURCE_FILE_EXTENSION_SET.has(baseName.slice(1))
  ) {
    return baseName.slice(1);
  }
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === baseName.length - 1) return null;
  return baseName.slice(dotIndex + 1);
}

function getUploadFileLabel(file: File) {
  const extension = getUploadFileExtension(file.name);
  if (!extension) return "FILE";
  if (["pdf"].includes(extension)) return "PDF";
  if (["doc", "docx"].includes(extension)) return "DOC";
  if (["pptx"].includes(extension)) return "PPT";
  if (["epub"].includes(extension)) return "EPUB";
  if (["csv", "tsv"].includes(extension)) return "CSV";
  if (extension === "json") return "JSON";
  if (extension === "srt") return "SRT";
  if (
    [
      "avif",
      "png",
      "jpg",
      "jpeg",
      "webp",
      "tif",
      "tiff",
      "bmp",
      "gif",
    ].includes(extension)
  ) {
    return "IMG";
  }
  if (
    [
      "flac",
      "mp3",
      "mp4",
      "mpeg",
      "mpga",
      "m4a",
      "ogg",
      "wav",
      "webm",
    ].includes(extension)
  ) {
    return "AUDIO";
  }
  return "TEXT";
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024)
    return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.round(ms / 6000) / 10}m`;
}

function formatJsonPreview(value: Record<string, unknown>) {
  const text = JSON.stringify(value, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}\n...` : text;
}

function basename(path: string) {
  const cleaned = path.replace(/\/+$/, "");
  return cleaned.split("/").pop() || cleaned || path;
}

function workfilePurposeLabel(purpose: WorkfileListItem["purpose"]) {
  if (purpose === "scratch") return "Scratch";
  if (purpose === "draft") return "Draft";
  if (purpose === "note") return "Note";
  if (purpose === "output_candidate") return "Candidate";
  return "Workfile";
}

function workfileMatchesQuery(file: WorkfileListItem, q: string) {
  return (
    file.path.toLowerCase().includes(q) ||
    basename(file.path).toLowerCase().includes(q) ||
    file.mimeType.toLowerCase().includes(q) ||
    workfilePurposeLabel(file.purpose).toLowerCase().includes(q)
  );
}

function isSupportedUploadFile(file: File) {
  const extension = getUploadFileExtension(file.name);
  if (extension && SOURCE_FILE_EXTENSION_SET.has(extension)) {
    return true;
  }
  return file.type.startsWith("text/");
}

function mapSourcesToUi(items: SourceApiRecord[]): SourceItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title || "Untitled",
    sourceType: item.sourceType,
    parentSourceId: item.parentSourceId,
    type: apiTypeToSourceType(item.sourceType, item.mimeType),
    status: apiStatusToSourceStatus(item.status),
    meta:
      item.sourceType === "directory"
        ? "Folder"
        : item.status === "failed"
          ? "Processing failed"
          : item.status === "queued" || item.status === "processing"
            ? "Sync in progress"
            : new Date(item.updatedAt).toLocaleString(),
    contentText: item.contentText,
    connectorId: item.connectorId,
    externalUri: item.externalUri,
    metadata: item.metadata,
    storageKey: item.storageKey,
    updatedAt: item.updatedAt,
  }));
}

function appendUniqueSources(current: SourceItem[], incoming: SourceItem[]) {
  const mergedById = new Map(current.map((source) => [source.id, source]));
  for (const source of incoming) {
    const existing = mergedById.get(source.id);
    if (!existing) {
      mergedById.set(source.id, source);
      continue;
    }
    const existingTime = existing.updatedAt
      ? Date.parse(existing.updatedAt)
      : 0;
    const incomingTime = source.updatedAt ? Date.parse(source.updatedAt) : 0;
    if (incomingTime >= existingTime) {
      mergedById.set(source.id, { ...existing, ...source });
    }
  }
  return Array.from(mergedById.values());
}

const upsertSources = appendUniqueSources;

function getIncrementalUpdatedAfter(value: string | null) {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(
    Math.max(0, timestamp - SOURCE_SYNC_UPDATED_AFTER_OVERLAP_MS),
  ).toISOString();
}

function createSourcesHubTabId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isDocumentVisible() {
  return typeof document === "undefined"
    ? true
    : document.visibilityState !== "hidden";
}

function shouldPollConnectorSyncRuns(tab: HubTab) {
  return ACTIVE_SYNC_RUN_TABS.has(tab);
}

function parseConnectorSyncRunBroadcastMessage(
  value: unknown,
): ConnectorSyncRunBroadcastMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<ConnectorSyncRunBroadcastMessage>;
  if (typeof message.type !== "string" || typeof message.tabId !== "string") {
    return null;
  }
  if (
    message.type !== "hello" &&
    message.type !== "leader-heartbeat" &&
    message.type !== "sync-runs-result" &&
    message.type !== "sync-runs-wake"
  ) {
    return null;
  }
  return value as ConnectorSyncRunBroadcastMessage;
}

function mergeSourceSelectionFromTree(
  nodes: SourceTreeNode[],
  selectedIds: string[],
  sourceIdsToAdd: string[],
) {
  if (sourceIdsToAdd.length === 0) {
    return selectedIds;
  }

  const nextIds = normalizeSourceSelectionFromTree(
    nodes,
    Array.from(new Set([...selectedIds, ...sourceIdsToAdd])),
  );

  return areStringArraysEqual(nextIds, selectedIds) ? selectedIds : nextIds;
}

function mapCitationsToUi(citations: CitationRecord[]): DisplayCitationItem[] {
  return citations.map((citation, index) => ({
    id: `citation-${citation.citation}-${citation.chunkId}`,
    citationRecord: citation,
    sourceTitle: citation.sourceTitle?.trim() || "Untitled source",
    messageLabel: `Reference ${index + 1}`,
    excerpt: citation.excerpt,
  }));
}

function mapThreadCitationsToUi(
  citations: ThreadCitationRecord[],
): DisplayCitationItem[] {
  return citations.map((item) => ({
    id: item.id,
    citationRecord: item.citation,
    messageId: item.messageId,
    sourceTitle: item.citation.sourceTitle?.trim() || "Untitled source",
    messageLabel: item.messageLabel,
    excerpt: item.citation.excerpt,
  }));
}

function StatusDot({ status }: { status: SourceItem["status"] }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        status === "Indexed"
          ? "bg-emerald-500"
          : status === "Syncing"
            ? "bg-amber-500"
            : status === "Failed"
              ? "bg-destructive"
              : "bg-red-400",
      )}
    />
  );
}

function SourceTypeIcon({
  isSelected,
  isPartiallySelected,
  source,
}: {
  isSelected: boolean;
  isPartiallySelected: boolean;
  source: SourceItem;
}) {
  if (source.sourceType === "directory" || source.type === "DIR") {
    return (
      <Folder
        className={cn(
          "size-3.5 shrink-0",
          isSelected || isPartiallySelected
            ? "text-primary"
            : "text-muted-foreground",
        )}
      />
    );
  }

  if (source.type === "AUDIO") {
    return <Music2 className="size-3 shrink-0 text-muted-foreground" />;
  }

  return <FileText className="size-3 shrink-0 text-muted-foreground" />;
}

function sourceConnectorType(source: SourceItem) {
  const metadataType = getRecordValue(source.metadata, "connectorType");
  return typeof metadataType === "string" && metadataType.trim()
    ? metadataType.trim()
    : typeof getRecordValue(source.metadata, "provider") === "string"
      ? (getRecordValue(source.metadata, "provider") as string)
      : null;
}

function sourceConnectorCatalogItem(source: SourceItem) {
  const connectorType = sourceConnectorType(source);
  if (!connectorType) return null;
  return connectorCatalog.find((item) => item.id === connectorType) ?? null;
}

function sourceConnectorLabel(source: SourceItem) {
  const catalogItem = sourceConnectorCatalogItem(source);
  const connectorType = sourceConnectorType(source);
  return catalogItem?.name ?? connectorType ?? "Connector";
}

function SourceProviderBadge({
  onOpenConnectorSettings,
  source,
}: {
  onOpenConnectorSettings?: (connectorId: string) => void;
  source: SourceItem;
}) {
  if (source.sourceType !== "connector") {
    return null;
  }
  const catalogItem = sourceConnectorCatalogItem(source);
  const label = sourceConnectorLabel(source);
  const connectorId = source.connectorId ?? null;
  const openSettings = onOpenConnectorSettings ?? null;
  const canOpenSettings = Boolean(connectorId && openSettings);
  const content = (
    <>
      {catalogItem?.logoIconName ? (
        <GlobalIcon
          className="size-3 shrink-0"
          fallbackIconName="tool"
          iconName={catalogItem.logoIconName}
          iconTone={catalogItem.logoIconTone ?? "brand"}
        />
      ) : catalogItem?.logoSrc ? (
        <RawImage
          alt=""
          className="size-3 shrink-0 object-contain"
          src={catalogItem.logoSrc}
        />
      ) : (
        <PlugIcon className="size-3 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </>
  );
  const className =
    "inline-flex max-w-28 shrink-0 items-center gap-1 rounded-md border border-input bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground";
  if (!canOpenSettings || !connectorId || !openSettings) {
    return <span className={className}>{content}</span>;
  }
  return (
    <button
      className={cn(
        className,
        "cursor-pointer hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      onClick={(event) => {
        event.stopPropagation();
        openSettings(connectorId);
      }}
      title={`Open ${label} connector settings`}
      type="button"
    >
      {content}
    </button>
  );
}

function areStringArraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function memoComponent<T extends (...args: never[]) => unknown>(component: T) {
  return memo(component as never) as unknown as T;
}

const SourceRow = memoComponent(function SourceRow({
  source,
  depth = 0,
  childCount = 0,
  selectionState,
  leading,
  onToggle,
  isBusy,
  isEditing,
  editTitle,
  onEditTitleChange,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onAddSource,
  onCreateDirectory,
  onDelete,
  onDownload,
  onEditReadme,
  onMove,
  onPreview,
  onReindex,
  onRetry,
  onOpenConnectorSettings,
}: {
  source: SourceItem;
  depth?: number;
  childCount?: number;
  selectionState: SourceSelectionState;
  leading?: ReactNode;
  onToggle: () => void;
  isBusy: boolean;
  isEditing: boolean;
  editTitle: string;
  onEditTitleChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: () => void;
  onAddSource: () => void;
  onCreateDirectory: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onEditReadme: () => void;
  onMove: () => void;
  onPreview: () => void;
  onReindex: () => void;
  onRetry: () => void;
  onOpenConnectorSettings?: (connectorId: string) => void;
}) {
  const isDirectory = source.sourceType === "directory";
  const isFailed = source.status === "Failed";
  const isSelectable = isSelectableSource(source);
  const isSelected = selectionState === true;
  const isPartiallySelected = selectionState === "indeterminate";
  const canSelect = isSelectable && !isBusy && !isEditing;
  const metaLabel =
    isDirectory && childCount > 0
      ? `${childCount} item${childCount === 1 ? "" : "s"}`
      : source.meta;

  function handleRowClick(event: MouseEvent<HTMLDivElement>) {
    if (!canSelect) {
      return;
    }

    const target = event.target as HTMLElement;
    if (
      target.closest(
        "button,input,textarea,select,a,[role='button'],[role='menuitem']",
      )
    ) {
      return;
    }

    onToggle();
  }

  function handleMenuAction(
    event: MouseEvent<HTMLElement>,
    action: () => void,
  ) {
    event.stopPropagation();
    action();
  }

  return (
    <div
      className={cn(
        "group flex min-h-8 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors",
        canSelect && "cursor-pointer hover:bg-accent/60",
        isFailed && "bg-muted/20 opacity-60",
      )}
      onClick={handleRowClick}
      style={{ paddingLeft: `${4 + depth * SOURCE_TREE_INDENT_PX}px` }}
    >
      {leading ?? <span className="size-5 shrink-0" />}
      <Checkbox
        checked={selectionState}
        className={cn(!isDirectory && !isEditing && "mt-0.5")}
        disabled={!canSelect}
        onCheckedChange={() => onToggle()}
      />

      <div className="min-w-0 flex-1">
        {isEditing ? (
          <div className="rounded-md border bg-background/95 p-2 shadow-xs">
            <div className="flex items-center gap-2">
              <SourceTypeIcon
                isPartiallySelected={isPartiallySelected}
                isSelected={isSelected}
                source={source}
              />
              <Input
                autoFocus
                className="h-8 min-w-0 flex-1 text-xs"
                disabled={isBusy}
                onChange={(e) => onEditTitleChange(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onSubmitRename();
                  }
                  if (event.key === "Escape") {
                    onCancelRename();
                  }
                }}
                value={editTitle}
              />
            </div>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <Button
                disabled={isBusy || !editTitle.trim()}
                onClick={onSubmitRename}
                size="xs"
                type="button"
                variant="outline"
              >
                Save
              </Button>
              <Button
                disabled={isBusy}
                onClick={onCancelRename}
                size="xs"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <SourceTypeIcon
                isPartiallySelected={isPartiallySelected}
                isSelected={isSelected}
                source={source}
              />
              <button
                className="cursor-pointer truncate text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isBusy || !isSelectable}
                onClick={isDirectory ? onToggle : onPreview}
                title={
                  isFailed
                    ? "Retry or delete this failed source"
                    : isDirectory
                      ? "Select folder"
                      : "Open preview"
                }
                type="button"
              >
                {source.title}
              </button>
              {isDirectory ? (
                <>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {metaLabel}
                  </span>
                  <TypeBadge label={source.type} />
                </>
              ) : null}
            </div>
            {!isDirectory ? (
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                <StatusDot status={source.status} />
                <span className="min-w-0 max-w-full truncate text-[10px] text-muted-foreground">
                  {metaLabel}
                </span>
                <SourceProviderBadge
                  onOpenConnectorSettings={onOpenConnectorSettings}
                  source={source}
                />
                <TypeBadge label={source.type} />
              </div>
            ) : null}
          </>
        )}
      </div>

      {!isEditing ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
              disabled={isBusy}
              onClick={(event) => event.stopPropagation()}
              size="icon-xs"
              title="Source actions"
              type="button"
              variant="ghost"
            >
              {isBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <MoreHorizontal className="size-3.5" />
              )}
              <span className="sr-only">Source actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {isFailed ? (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={(event) => handleMenuAction(event, onRetry)}
              >
                <RotateCcw className="size-3.5" />
                Retry
              </DropdownMenuItem>
            ) : null}
            {isDirectory ? (
              <>
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={(event) => handleMenuAction(event, onAddSource)}
                >
                  <Upload className="size-3.5" />
                  Add source
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={(event) =>
                    handleMenuAction(event, onCreateDirectory)
                  }
                >
                  <FolderPlus className="size-3.5" />
                  New folder
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={(event) => handleMenuAction(event, onEditReadme)}
                >
                  <FileText className="size-3.5" />
                  Edit README
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={(event) => handleMenuAction(event, onPreview)}
                >
                  <FileText className="size-3.5" />
                  Preview
                </DropdownMenuItem>
                {source.storageKey ? (
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    onClick={(event) => handleMenuAction(event, onDownload)}
                  >
                    <Download className="size-3.5" />
                    Download
                  </DropdownMenuItem>
                ) : null}
              </>
            )}
            <DropdownMenuItem
              className="whitespace-nowrap"
              onClick={(event) => handleMenuAction(event, onStartRename)}
            >
              <Pencil className="size-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="whitespace-nowrap"
              onClick={(event) => handleMenuAction(event, onMove)}
            >
              <MoveRight className="size-3.5" />
              Move to...
            </DropdownMenuItem>
            {!isDirectory ? (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={(event) => handleMenuAction(event, onReindex)}
              >
                <RotateCcw className="size-3.5" />
                Re-index
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className="whitespace-nowrap"
              onClick={(event) => handleMenuAction(event, onDelete)}
              variant="destructive"
            >
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
});

function sourceMatchesQuery(source: SourceItem, q: string) {
  const connectorLabel = sourceConnectorLabel(source).toLowerCase();
  return (
    source.title.toLowerCase().includes(q) ||
    source.type.toLowerCase().includes(q) ||
    source.status.toLowerCase().includes(q) ||
    source.meta.toLowerCase().includes(q) ||
    connectorLabel.includes(q)
  );
}

function getRecordValue(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const SourceTreeRow = memoComponent(function SourceTreeRow({
  node,
  depth,
  autoExpand = false,
  forceFlat = false,
  selectionStateById,
  onToggle,
  rowBusyById,
  editingId,
  editingTitle,
  onEditTitleChange,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onAddSource,
  onCreateDirectory,
  onDelete,
  onDownload,
  onEditReadme,
  onMove,
  onPreview,
  onReindex,
  onRetry,
  onOpenConnectorSettings,
  expandedDirectoryIds,
  userCollapsedDirectoryIds,
  onDirectoryExpandedChange,
}: {
  node: SourceTreeNode;
  depth: number;
  autoExpand?: boolean;
  forceFlat?: boolean;
  selectionStateById: Map<string, SourceSelectionState>;
  onToggle: (node: SourceTreeNode) => void;
  rowBusyById: Record<string, boolean>;
  editingId: string | null;
  editingTitle: string;
  onEditTitleChange: (value: string) => void;
  onStartRename: (source: SourceItem) => void;
  onCancelRename: () => void;
  onSubmitRename: (id: string) => void;
  onAddSource: (parentSourceId: string) => void;
  onCreateDirectory: (parentSourceId: string) => void;
  onDelete: (source: SourceItem) => void;
  onDownload: (source: SourceItem) => void;
  onEditReadme: (source: SourceItem) => void;
  onMove: (source: SourceItem) => void;
  onPreview: (source: SourceItem) => void;
  onReindex: (source: SourceItem) => void;
  onRetry: (source: SourceItem) => void;
  onOpenConnectorSettings?: (connectorId: string) => void;
  expandedDirectoryIds: Set<string>;
  userCollapsedDirectoryIds: Set<string>;
  onDirectoryExpandedChange: (sourceId: string, open: boolean) => void;
}) {
  const source = node.source;
  const isDirectory = source.sourceType === "directory";
  const selectionState = selectionStateById.get(source.id) ?? false;
  const managedOpen =
    expandedDirectoryIds.has(source.id) &&
    !userCollapsedDirectoryIds.has(source.id);
  const open = autoExpand || managedOpen;

  function handleDirectoryOpenChange(nextOpen: boolean) {
    onDirectoryExpandedChange(source.id, nextOpen);
  }

  const directoryToggle = isDirectory ? (
    <button
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        handleDirectoryOpenChange(!open);
      }}
      title={open ? "Collapse folder" : "Expand folder"}
      type="button"
    >
      {open ? (
        <ChevronDown className="size-3.5" />
      ) : (
        <ChevronRight className="size-3.5" />
      )}
    </button>
  ) : undefined;

  if (!isDirectory || forceFlat) {
    const noop = () => {};
    return (
      <SourceRow
        childCount={isDirectory ? node.children.length : undefined}
        depth={depth}
        editTitle={editingTitle}
        isBusy={Boolean(rowBusyById[source.id])}
        isEditing={editingId === source.id}
        leading={directoryToggle}
        onCancelRename={onCancelRename}
        onAddSource={isDirectory ? () => onAddSource(source.id) : noop}
        onCreateDirectory={
          isDirectory ? () => onCreateDirectory(source.id) : noop
        }
        onDelete={() => onDelete(source)}
        onDownload={() => onDownload(source)}
        onEditReadme={() => onEditReadme(source)}
        onEditTitleChange={onEditTitleChange}
        onMove={() => onMove(source)}
        onPreview={() => onPreview(source)}
        onReindex={() => onReindex(source)}
        onRetry={() => onRetry(source)}
        onOpenConnectorSettings={onOpenConnectorSettings}
        onStartRename={() => onStartRename(source)}
        onSubmitRename={() => onSubmitRename(source.id)}
        onToggle={() => onToggle(node)}
        selectionState={selectionState}
        source={source}
      />
    );
  }

  return (
    <Collapsible onOpenChange={handleDirectoryOpenChange} open={open}>
      <SourceRow
        childCount={node.children.length}
        depth={depth}
        editTitle={editingTitle}
        isBusy={Boolean(rowBusyById[source.id])}
        isEditing={editingId === source.id}
        leading={
          <CollapsibleTrigger asChild>{directoryToggle}</CollapsibleTrigger>
        }
        onCancelRename={onCancelRename}
        onAddSource={() => onAddSource(source.id)}
        onCreateDirectory={() => onCreateDirectory(source.id)}
        onDelete={() => onDelete(source)}
        onDownload={() => onDownload(source)}
        onEditReadme={() => onEditReadme(source)}
        onEditTitleChange={onEditTitleChange}
        onMove={() => onMove(source)}
        onPreview={() => onPreview(source)}
        onReindex={() => onReindex(source)}
        onRetry={() => onRetry(source)}
        onOpenConnectorSettings={onOpenConnectorSettings}
        onStartRename={() => onStartRename(source)}
        onSubmitRename={() => onSubmitRename(source.id)}
        onToggle={() => onToggle(node)}
        selectionState={selectionState}
        source={source}
      />
      <CollapsibleContent>
        <div
          className="relative space-y-0.5 before:absolute before:bottom-1 before:top-0 before:left-[var(--source-tree-branch-left)] before:w-px before:bg-border/70"
          style={
            {
              "--source-tree-branch-left": `${9 + depth * SOURCE_TREE_INDENT_PX}px`,
            } as CSSProperties
          }
        >
          {node.children.map((child) => (
            <SourceTreeRow
              autoExpand={autoExpand}
              depth={depth + 1}
              editingId={editingId}
              editingTitle={editingTitle}
              key={child.source.id}
              node={child}
              expandedDirectoryIds={expandedDirectoryIds}
              onCancelRename={onCancelRename}
              onAddSource={onAddSource}
              onCreateDirectory={onCreateDirectory}
              onDelete={onDelete}
              onDownload={onDownload}
              onEditReadme={onEditReadme}
              onEditTitleChange={onEditTitleChange}
              onMove={onMove}
              onPreview={onPreview}
              onReindex={onReindex}
              onRetry={onRetry}
              onOpenConnectorSettings={onOpenConnectorSettings}
              onDirectoryExpandedChange={onDirectoryExpandedChange}
              onStartRename={onStartRename}
              onSubmitRename={onSubmitRename}
              onToggle={onToggle}
              rowBusyById={rowBusyById}
              selectionStateById={selectionStateById}
              userCollapsedDirectoryIds={userCollapsedDirectoryIds}
            />
          ))}
          {node.children.length === 0 ? (
            <div
              className="flex min-h-8 items-center rounded-md px-1.5 py-1 text-xs text-muted-foreground"
              style={{
                paddingLeft: `${4 + (depth + 1) * SOURCE_TREE_INDENT_PX}px`,
              }}
            >
              Empty folder
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

function HubEmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-8 text-center">
      <Icon className="mx-auto size-5 text-muted-foreground" />
      <h4 className="mt-3 text-sm font-medium text-foreground">{title}</h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

const WorkfilesTab = memoComponent(function WorkfilesTab({
  files,
  isLoading,
  loadingError,
  onDelete,
  onOpen,
  onRefresh,
  rowBusyByPath,
  searchQuery,
}: {
  files: WorkfileListItem[];
  isLoading: boolean;
  loadingError: string | null;
  onDelete: (file: WorkfileListItem) => void;
  onOpen: (file: WorkfileListItem) => void;
  onRefresh: () => void;
  rowBusyByPath: Record<string, boolean>;
  searchQuery: string;
}) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? files.filter((file) => workfileMatchesQuery(file, q)) : files),
    [files, q],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-3.5 animate-spin" />
        Loading workfiles...
      </div>
    );
  }

  if (loadingError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">{loadingError}</p>
        <Button
          className="mt-2"
          onClick={onRefresh}
          size="xs"
          type="button"
          variant="outline"
        >
          <RotateCcw className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <HubEmptyState
        description={
          searchQuery
            ? "Try a different path, purpose, or file type."
            : "Assistant-created plans, notes, extraction tables, calculations, drafts, and candidate outputs from complex work will appear here."
        }
        icon={FileText}
        title={
          searchQuery
            ? `No workfiles match "${searchQuery}"`
            : "Workfiles will appear here."
        }
      />
    );
  }

  return (
    <div className="space-y-1">
      {filtered.map((file) => {
        const busy = Boolean(rowBusyByPath[file.path]);
        return (
          <article
            className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60"
            key={file.id}
          >
            <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <button
                className="block w-full cursor-pointer truncate text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                disabled={busy}
                onClick={() => onOpen(file)}
                title={file.path}
                type="button"
              >
                {basename(file.path)}
              </button>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="truncate">{file.path}</span>
                <span>{formatBytes(file.sizeBytes)}</span>
                <span>{new Date(file.updatedAt).toLocaleString()}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {file.purpose ? (
                  <TypeBadge label={workfilePurposeLabel(file.purpose)} />
                ) : null}
                <TypeBadge label={file.mimeType} />
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  disabled={busy}
                  onClick={(event) => event.stopPropagation()}
                  size="icon-xs"
                  title="Workfile actions"
                  type="button"
                  variant="ghost"
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <MoreHorizontal className="size-3.5" />
                  )}
                  <span className="sr-only">Workfile actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={() => onOpen(file)}
                >
                  <FileText className="size-3.5" />
                  Preview
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={() => onDelete(file)}
                  variant="destructive"
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </article>
        );
      })}
    </div>
  );
});

const ArtifactsTab = memoComponent(function ArtifactsTab({
  artifacts,
  hasMore,
  isLoading,
  isLoadingMore,
  loadingError,
  onLoadMore,
  onPreview,
  onRefresh,
  searchQuery,
  workspaceId,
}: {
  artifacts: ArtifactListItem[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadingError: string | null;
  onLoadMore: () => void;
  onPreview: (artifact: ArtifactListItem) => void;
  onRefresh: () => void;
  searchQuery: string;
  workspaceId?: string | null;
}) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? artifacts.filter((artifact) => artifactMatchesQuery(artifact, q))
        : artifacts,
    [artifacts, q],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-3.5 animate-spin" />
        Loading artifacts...
      </div>
    );
  }

  if (loadingError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">{loadingError}</p>
        <Button
          className="mt-2"
          onClick={onRefresh}
          size="xs"
          type="button"
          variant="outline"
        >
          <RotateCcw className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="space-y-2">
        <HubEmptyState
          description={
            searchQuery
              ? "Try a different title, artifact type, or prompt."
              : "Reports, slides, images, tables, audio briefs, and other finished deliverables will appear here."
          }
          icon={Sparkles}
          title={
            searchQuery
              ? `No artifacts match "${searchQuery}"`
              : "Finished artifacts will appear here."
          }
        />
        {hasMore && searchQuery ? (
          <Button
            className="w-full"
            disabled={isLoadingMore}
            onClick={onLoadMore}
            size="sm"
            type="button"
            variant="outline"
          >
            {isLoadingMore ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Load more
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filtered.map((artifact) => {
        const proxyFileUrl = resolveArtifactProxyFileUrl({
          artifact,
          workspaceId,
        });
        const previewImage = artifactPreviewImageMetadata(artifact);
        const previewImageUrl = resolveArtifactPreviewImageProxyUrl({
          artifact,
          workspaceId,
        });

        return (
          <button
            className="group relative isolate flex w-full items-start gap-3 rounded-lg border border-border/70 bg-background p-2.5 text-left shadow-xs outline-none transition-[background-color,border-color,box-shadow] hover:border-foreground/25 hover:bg-accent/35 hover:shadow-sm hover:shadow-foreground/5 focus-visible:border-primary/45 focus-visible:bg-accent/30 focus-visible:shadow-[0_8px_24px_-18px_hsl(var(--foreground)/0.45),0_0_0_1px_hsl(var(--primary)/0.18)] focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:rounded-[inherit] focus-visible:after:shadow-[inset_0_0_0_2px_hsl(var(--ring)/0.55)] focus-visible:after:content-['']"
            key={artifact.id}
            onClick={() => onPreview(artifact)}
            title={`Preview ${artifactTitle(artifact)}`}
            type="button"
          >
            {previewImageUrl ? (
              <span className="block h-14 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                <RawImage
                  alt={previewImage?.altText ?? artifactTitle(artifact)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  src={previewImageUrl}
                />
              </span>
            ) : artifact.artifactType === "image" && proxyFileUrl ? (
              <span className="block h-14 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                <RawImage
                  alt={artifactTitle(artifact)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  src={proxyFileUrl}
                />
              </span>
            ) : artifact.artifactType === "slides" ? (
              <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
                <Presentation className="size-4 text-muted-foreground" />
              </div>
            ) : (
              <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
                <Sparkles className="size-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-medium text-foreground underline-offset-2 group-hover:underline">
                  {artifactTitle(artifact)}
                </span>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{new Date(artifact.createdAt).toLocaleString()}</span>
                {artifact.completedAt ? (
                  <span>
                    completed {new Date(artifact.completedAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <TypeBadge label={artifactTypeLabel(artifact.artifactType)} />
                <TypeBadge label={artifact.status} />
              </div>
              {artifact.promptText ? (
                <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {artifact.promptText}
                </p>
              ) : null}
            </div>
          </button>
        );
      })}
      {hasMore ? (
        <Button
          className="w-full"
          disabled={isLoadingMore}
          onClick={onLoadMore}
          size="sm"
          type="button"
          variant="outline"
        >
          {isLoadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
});

function SourcesTab({
  sourceTreeIndex,
  searchQuery,
  selectedIds,
  onToggle,
  rowBusyById,
  editingId,
  editingTitle,
  onEditTitleChange,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onAddSource,
  onCreateDirectory,
  onDelete,
  onDownload,
  onEditReadme,
  onMove,
  onPreview,
  onReindex,
  onRetry,
  onOpenConnectorSettings,
  expandedDirectoryIds,
  userCollapsedDirectoryIds,
  onDirectoryExpandedChange,
}: {
  sourceTreeIndex: SourceTreeIndex;
  searchQuery: string;
  selectedIds: string[];
  onToggle: (node: SourceTreeNode) => void;
  rowBusyById: Record<string, boolean>;
  editingId: string | null;
  editingTitle: string;
  onEditTitleChange: (value: string) => void;
  onStartRename: (source: SourceItem) => void;
  onCancelRename: () => void;
  onSubmitRename: (id: string) => void;
  onAddSource: (parentSourceId: string) => void;
  onCreateDirectory: (parentSourceId: string) => void;
  onDelete: (source: SourceItem) => void;
  onDownload: (source: SourceItem) => void;
  onEditReadme: (source: SourceItem) => void;
  onMove: (source: SourceItem) => void;
  onPreview: (source: SourceItem) => void;
  onReindex: (source: SourceItem) => void;
  onRetry: (source: SourceItem) => void;
  onOpenConnectorSettings?: (connectorId: string) => void;
  expandedDirectoryIds: Set<string>;
  userCollapsedDirectoryIds: Set<string>;
  onDirectoryExpandedChange: (sourceId: string, open: boolean) => void;
}) {
  const tree = useMemo(
    () =>
      buildSourceTreeFromIndex(
        sourceTreeIndex,
        searchQuery,
        sourceMatchesQuery,
      ),
    [sourceTreeIndex, searchQuery],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectionStateById = useMemo(
    () => buildSourceSelectionStateMap(tree, selectedSet),
    [selectedSet, tree],
  );
  const treeNodeCount = useMemo(() => countTreeNodes(tree), [tree]);
  const autoExpandRows = Boolean(searchQuery);
  const flatTreeRows = useMemo(
    () =>
      flattenVisibleSourceTree(tree, {
        autoExpand: autoExpandRows,
        expandedDirectoryIds,
        userCollapsedDirectoryIds,
      }),
    [autoExpandRows, expandedDirectoryIds, tree, userCollapsedDirectoryIds],
  );
  const shouldVirtualize =
    flatTreeRows.length > SOURCE_TREE_VIRTUALIZE_THRESHOLD;
  const virtualRows = useVirtualRows({
    enabled: shouldVirtualize,
    overscanRows: SOURCE_TREE_OVERSCAN_ROWS,
    rowCount: flatTreeRows.length,
    rowHeight: SOURCE_TREE_ROW_HEIGHT_PX,
  });
  const visibleFlatRows = shouldVirtualize
    ? flatTreeRows.slice(virtualRows.startIndex, virtualRows.endIndex)
    : flatTreeRows;

  if (treeNodeCount === 0) {
    return (
      <HubEmptyState
        description={
          searchQuery
            ? "Try a different source title, folder, type, or status."
            : "Add documents, links, notes, or folders to build the source set for this project."
        }
        icon={FileText}
        title={
          searchQuery
            ? `No sources match "${searchQuery}"`
            : "Sources will appear here."
        }
      />
    );
  }

  if (shouldVirtualize) {
    return (
      <div className="flex h-full min-h-0 flex-col space-y-2">
        <div
          className="min-h-0 flex-1 overflow-y-auto pr-1"
          onScroll={virtualRows.onScroll}
          ref={virtualRows.containerRef}
        >
          <div
            className="relative"
            style={{ height: `${virtualRows.totalHeight}px` }}
          >
            <div
              className="absolute inset-x-0 top-0 space-y-0.5"
              style={{
                transform: `translateY(${virtualRows.topPadding}px)`,
              }}
            >
              {visibleFlatRows.map(({ depth, node }) => (
                <SourceTreeRow
                  autoExpand={Boolean(searchQuery)}
                  depth={depth}
                  editingId={editingId}
                  editingTitle={editingTitle}
                  forceFlat
                  key={node.source.id}
                  expandedDirectoryIds={expandedDirectoryIds}
                  node={node}
                  onCancelRename={onCancelRename}
                  onAddSource={onAddSource}
                  onCreateDirectory={onCreateDirectory}
                  onDelete={onDelete}
                  onDownload={onDownload}
                  onEditReadme={onEditReadme}
                  onEditTitleChange={onEditTitleChange}
                  onMove={onMove}
                  onPreview={onPreview}
                  onReindex={onReindex}
                  onRetry={onRetry}
                  onOpenConnectorSettings={onOpenConnectorSettings}
                  onDirectoryExpandedChange={onDirectoryExpandedChange}
                  onStartRename={onStartRename}
                  onSubmitRename={onSubmitRename}
                  onToggle={onToggle}
                  rowBusyById={rowBusyById}
                  selectionStateById={selectionStateById}
                  userCollapsedDirectoryIds={userCollapsedDirectoryIds}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col space-y-2">
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {flatTreeRows.map(({ depth, node }) => (
          <SourceTreeRow
            autoExpand={Boolean(searchQuery)}
            depth={depth}
            editingId={editingId}
            editingTitle={editingTitle}
            forceFlat
            key={node.source.id}
            expandedDirectoryIds={expandedDirectoryIds}
            node={node}
            onCancelRename={onCancelRename}
            onAddSource={onAddSource}
            onCreateDirectory={onCreateDirectory}
            onDelete={onDelete}
            onDownload={onDownload}
            onEditReadme={onEditReadme}
            onEditTitleChange={onEditTitleChange}
            onMove={onMove}
            onPreview={onPreview}
            onReindex={onReindex}
            onRetry={onRetry}
            onOpenConnectorSettings={onOpenConnectorSettings}
            onDirectoryExpandedChange={onDirectoryExpandedChange}
            onStartRename={onStartRename}
            onSubmitRename={onSubmitRename}
            onToggle={onToggle}
            rowBusyById={rowBusyById}
            selectionStateById={selectionStateById}
            userCollapsedDirectoryIds={userCollapsedDirectoryIds}
          />
        ))}
      </div>
    </div>
  );
}

function skillSourceLabel(sourceType: HubSkillItem["sourceType"]) {
  if (sourceType === "builtin") return "Official";
  if (sourceType === "team_custom") return "Team";
  return "Workspace";
}

function SkillReadmeDialog({
  catalogId,
  onOpenChange,
  open,
  workspaceId,
}: {
  catalogId: string | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceId?: string | null;
}) {
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof contentClient.getSkillCatalogDetail>
  > | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!open || !workspaceId || !catalogId) {
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setDetail(null);
    contentClient
      .getSkillCatalogDetail(workspaceId, catalogId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(getErrorMessage(error, "Failed to load skill details."));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogId, open, workspaceId]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid max-h-[min(720px,calc(100svh-2rem))] w-[720px] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle>{detail?.skill.displayName ?? "Skill"}</DialogTitle>
          <DialogDescription>
            {detail?.skill.description ??
              "Review this skill before selecting it."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-14 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading skill...
            </div>
          ) : detail?.readmeContent ? (
            <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
              {detail.readmeContent}
            </MessageResponse>
          ) : (
            <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
              This skill does not include a README.md introduction yet.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DirectoryPicker({
  sources,
  value,
  onChange,
  excludeSourceId,
  framed = true,
}: {
  sources: SourceItem[];
  value: string | null;
  onChange: (value: string | null) => void;
  excludeSourceId?: string | null;
  framed?: boolean;
}) {
  const excludedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!excludeSourceId) return ids;
    ids.add(excludeSourceId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const source of sources) {
        if (
          source.parentSourceId &&
          ids.has(source.parentSourceId) &&
          !ids.has(source.id)
        ) {
          ids.add(source.id);
          changed = true;
        }
      }
    }
    return ids;
  }, [excludeSourceId, sources]);
  const directoryTree = useMemo(
    () =>
      buildSourceTree(
        sources.filter(
          (source) =>
            source.sourceType === "directory" && !excludedIds.has(source.id),
        ),
        "",
      ),
    [excludedIds, sources],
  );

  function renderNode(node: SourceTreeNode, depth: number) {
    return (
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
          value === node.source.id && "bg-primary/10 text-primary",
        )}
        key={node.source.id}
        onClick={() => onChange(node.source.id)}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        type="button"
      >
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{node.source.title}</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "max-h-56 overflow-y-auto",
        framed ? "rounded-lg border bg-background p-1" : "py-1",
      )}
    >
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent",
          value === null && "bg-primary/10 text-primary",
        )}
        onClick={() => onChange(null)}
        type="button"
      >
        <Folder className="size-3.5 shrink-0" />
        <span>Sources root</span>
      </button>
      <div className="ml-3 border-l border-border/70 pl-1">
        {directoryTree.map(function render(node) {
          function renderTree(current: SourceTreeNode, depth: number) {
            return (
              <div key={current.source.id}>
                {renderNode(current, depth)}
                {current.children.map((child) => renderTree(child, depth + 1))}
              </div>
            );
          }
          return renderTree(node, 0);
        })}
      </div>
    </div>
  );
}

function AddSourceDialog({
  addParentSourceId,
  addTab,
  files,
  fileInputRef,
  isDragActive,
  isOpen,
  isSubmitting,
  onAddFiles,
  onAddTabChange,
  onClose,
  onCreateTextSource,
  onCreateUrlSource,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  onRemoveFile,
  onTextContentChange,
  onTextTitleChange,
  onUploadFiles,
  onUrlTitleChange,
  onUrlValueChange,
  sources,
  textContent,
  textTitle,
  uploadProgress,
  urlTitle,
  urlValue,
}: {
  addParentSourceId: string | null;
  addTab: AddTab;
  files: File[];
  fileInputRef: { current: HTMLInputElement | null };
  isDragActive: boolean;
  isOpen: boolean;
  isSubmitting: boolean;
  onAddFiles: (files: File[]) => void;
  onAddTabChange: (tab: AddTab) => void;
  onClose: (open: boolean) => void;
  onCreateTextSource: () => void;
  onCreateUrlSource: () => void;
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onRemoveFile: (index: number) => void;
  onTextContentChange: (value: string) => void;
  onTextTitleChange: (value: string) => void;
  onUploadFiles: () => void;
  onUrlTitleChange: (value: string) => void;
  onUrlValueChange: (value: string) => void;
  sources: SourceItem[];
  textContent: string;
  textTitle: string;
  uploadProgress: number;
  urlTitle: string;
  urlValue: string;
}) {
  return (
    <Dialog onOpenChange={onClose} open={isOpen}>
      <DialogContent
        className="w-[640px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>
            Add web pages, text notes, or uploaded files as sources.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {addParentSourceId ? (
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/25 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Folder className="size-3.5" />
              <span className="truncate">
                {sources.find((source) => source.id === addParentSourceId)
                  ?.title ?? "Selected folder"}
              </span>
            </div>
          ) : null}
          <div className="flex gap-1 rounded-lg border bg-muted/30 p-1">
            {addTabs.map((tab) => (
              <button
                className={cn(
                  "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  addTab === tab
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={tab}
                onClick={() => onAddTabChange(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="h-72">
            {addTab === "Text" ? (
              <div className="flex h-full flex-col gap-2">
                <Input
                  onChange={(event) => onTextTitleChange(event.target.value)}
                  placeholder="Title (optional)"
                  value={textTitle}
                />
                <Textarea
                  className="min-h-0 flex-1"
                  onChange={(event) => onTextContentChange(event.target.value)}
                  placeholder="Paste or write source content..."
                  value={textContent}
                />
              </div>
            ) : addTab === "URL" ? (
              <div className="flex h-full flex-col gap-2">
                <Input
                  onChange={(event) => onUrlValueChange(event.target.value)}
                  placeholder="https://example.com/article"
                  type="url"
                  value={urlValue}
                />
                <Input
                  onChange={(event) => onUrlTitleChange(event.target.value)}
                  placeholder="Title (optional)"
                  value={urlTitle}
                />
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed bg-muted/20 px-6 text-center text-xs text-muted-foreground">
                  SourceWeft will fetch the page content and index it for
                  search.
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div
                  className={cn(
                    "rounded-lg border border-dashed px-4 py-5 text-center text-xs transition-colors",
                    isDragActive
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/40",
                  )}
                  onDragEnter={onDragEnter}
                  onDragLeave={onDragLeave}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                >
                  <input
                    accept={SOURCE_FILE_ACCEPT}
                    className="hidden"
                    ref={fileInputRef}
                    multiple
                    onChange={(event) => {
                      onAddFiles(Array.from(event.target.files ?? []));
                      event.currentTarget.value = "";
                    }}
                    type="file"
                  />
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <Upload className="size-3.5" />
                    {isDragActive ? "Drop files here" : "Drag files here"}
                  </span>
                  <p className="mt-1 text-[10px]">
                    or
                    <button
                      className="mx-1 inline font-medium text-foreground underline underline-offset-2"
                      onClick={() => fileInputRef.current?.click()}
                      type="button"
                    >
                      browse
                    </button>
                    files
                  </p>
                  <p className="mt-1 text-[10px]">
                    Up to {MAX_FILES} files, {MAX_FILE_SIZE_MB}MB each
                  </p>
                </div>

                <div className="min-h-0 flex-1 rounded-lg border p-2">
                  {files.length > 0 ? (
                    <div className="h-full space-y-1.5 overflow-y-auto">
                      {files.map((file, index) => (
                        <div
                          className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5"
                          key={`${file.name}-${file.size}-${index}`}
                        >
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-foreground">
                              {file.name}
                            </span>
                          </div>
                          <TypeBadge label={getUploadFileLabel(file)} />
                          <Button
                            onClick={() => onRemoveFile(index)}
                            size="icon-xs"
                            type="button"
                            variant="ghost"
                          >
                            <X className="size-3.5" />
                            <span className="sr-only">Remove file</span>
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
                      No files selected
                    </div>
                  )}
                </div>

                {isSubmitting ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Uploading</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <Progress className="h-1.5" value={uploadProgress} />
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onClose(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={
              isSubmitting ||
              (addTab === "Text" && !textContent.trim()) ||
              (addTab === "URL" && !urlValue.trim()) ||
              (addTab === "File" && files.length === 0)
            }
            onClick={() =>
              addTab === "Text"
                ? onCreateTextSource()
                : addTab === "URL"
                  ? onCreateUrlSource()
                  : onUploadFiles()
            }
            type="button"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Working...
              </>
            ) : (
              <>
                {addTab === "Text"
                  ? "Create source"
                  : addTab === "URL"
                    ? "Add URL"
                    : "Upload files"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateDirectoryDialog({
  directoryContext,
  directoryParentSourceId,
  directoryTitle,
  isOpen,
  isSubmitting,
  onContextChange,
  onCreate,
  onOpenChange,
  onParentChange,
  onTitleChange,
  sources,
}: {
  directoryContext: string;
  directoryParentSourceId: string | null;
  directoryTitle: string;
  isOpen: boolean;
  isSubmitting: boolean;
  onContextChange: (value: string) => void;
  onCreate: () => void;
  onOpenChange: (open: boolean) => void;
  onParentChange: (value: string | null) => void;
  onTitleChange: (value: string) => void;
  sources: SourceItem[];
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={isOpen}>
      <DialogContent
        className="w-[520px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Create folder</DialogTitle>
          <DialogDescription>
            Add a folder to organize Sources.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            autoFocus
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Folder name"
            value={directoryTitle}
          />
          <Textarea
            className="min-h-28"
            onChange={(event) => onContextChange(event.target.value)}
            placeholder="README context (optional)"
            value={directoryContext}
          />
          <DirectoryPicker
            onChange={onParentChange}
            sources={sources}
            value={directoryParentSourceId}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={isSubmitting || !directoryTitle.trim()}
            onClick={onCreate}
            type="button"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Working...
              </>
            ) : (
              "Create folder"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MoveSourceDialog({
  isSubmitting,
  moveParentSourceId,
  moveSource,
  onMove,
  onMoveSourceChange,
  onOpenChange,
  sources,
}: {
  isSubmitting: boolean;
  moveParentSourceId: string | null;
  moveSource: SourceItem | null;
  onMove: () => void;
  onMoveSourceChange: (value: string | null) => void;
  onOpenChange: (open: boolean) => void;
  sources: SourceItem[];
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(moveSource)}>
      <DialogContent
        className="w-[520px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Move source</DialogTitle>
          <DialogDescription>
            Choose a destination under the root directory.
          </DialogDescription>
        </DialogHeader>
        {moveSource ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/25 px-3 py-2">
            <SourceTypeIcon
              isPartiallySelected={false}
              isSelected={false}
              source={moveSource}
            />
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Moving
              </div>
              <div className="truncate text-sm font-medium text-foreground">
                {moveSource.title}
              </div>
            </div>
          </div>
        ) : null}
        <DirectoryPicker
          excludeSourceId={moveSource?.id}
          framed={false}
          onChange={onMoveSourceChange}
          sources={sources}
          value={moveParentSourceId}
        />
        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isSubmitting} onClick={onMove} type="button">
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Moving...
              </>
            ) : (
              "Move"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReadmeDialog({
  isSubmitting,
  onContentChange,
  onOpenChange,
  onSave,
  readmeContent,
  readmeSource,
}: {
  isSubmitting: boolean;
  onContentChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  readmeContent: string;
  readmeSource: SourceItem | null;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(readmeSource)}>
      <DialogContent
        className="w-[640px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Edit README</DialogTitle>
          <DialogDescription>
            Update the context attached to this folder.
          </DialogDescription>
        </DialogHeader>
        {readmeSource ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/25 px-3 py-2">
            <SourceTypeIcon
              isPartiallySelected={false}
              isSelected={false}
              source={readmeSource}
            />
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Folder
              </div>
              <div className="truncate text-sm font-medium text-foreground">
                {readmeSource.title}
              </div>
            </div>
          </div>
        ) : null}
        <Textarea
          className="min-h-52 text-sm"
          onChange={(event) => onContentChange(event.target.value)}
          placeholder="README context for this folder..."
          value={readmeContent}
        />
        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isSubmitting} onClick={onSave} type="button">
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Saving...
              </>
            ) : (
              "Save README"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkfilePreviewDialog({
  onOpenChange,
  previewWorkfile,
}: {
  onOpenChange: (open: boolean) => void;
  previewWorkfile: WorkfileDetail | null;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(previewWorkfile)}>
      <DialogContent
        className="grid max-h-[min(720px,calc(100svh-2rem))] w-[760px] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle>
            {previewWorkfile ? basename(previewWorkfile.path) : "Workfile"}
          </DialogTitle>
          <DialogDescription>
            {previewWorkfile
              ? `${previewWorkfile.path} · ${formatBytes(previewWorkfile.sizeBytes)} · ${workfilePurposeLabel(previewWorkfile.purpose)}`
              : "Assistant-created working material from this thread."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-5">
          {previewWorkfile ? (
            <WorkfileContentViewer
              className="h-full min-h-[360px]"
              contentText={previewWorkfile.contentText}
              mimeType={previewWorkfile.mimeType}
              path={previewWorkfile.path}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteSourceDialog({
  deleteSource,
  onConfirm,
  onOpenChange,
  rowBusyById,
}: {
  deleteSource: SourceItem | null;
  onConfirm: (source: SourceItem) => void;
  onOpenChange: (open: boolean) => void;
  rowBusyById: Record<string, boolean>;
}) {
  const isDeleting = Boolean(deleteSource && rowBusyById[deleteSource.id]);

  return (
    <AlertDialog onOpenChange={onOpenChange} open={Boolean(deleteSource)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete{" "}
            {deleteSource?.sourceType === "directory" ? "folder" : "source"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleteSource?.sourceType === "directory"
              ? "This will remove the folder and its sources from this workspace. This action cannot be undone."
              : "This will remove the source from this workspace. This action cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteSource ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">
              {deleteSource.title}
            </span>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              if (deleteSource) {
                onConfirm(deleteSource);
              }
            }}
          >
            {isDeleting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteSelectedSourcesDialog({
  count,
  isDeleting,
  onConfirm,
  onOpenChange,
  open,
}: {
  count: number;
  isDeleting: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete selected sources?</AlertDialogTitle>
          <AlertDialogDescription>
            This will delete {count} selected source{count === 1 ? "" : "s"},
            including contents of any selected folders. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={isDeleting || count === 0}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteWorkfileDialog({
  deleteWorkfile,
  onConfirm,
  onOpenChange,
  workfileBusyByPath,
}: {
  deleteWorkfile: WorkfileListItem | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  workfileBusyByPath: Record<string, boolean>;
}) {
  const isDeleting = Boolean(
    deleteWorkfile && workfileBusyByPath[deleteWorkfile.path],
  );

  return (
    <AlertDialog onOpenChange={onOpenChange} open={Boolean(deleteWorkfile)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete workfile?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the Workfile from this thread. This action cannot
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteWorkfile ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">
              {deleteWorkfile.path}
            </span>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isDeleting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function useAddSourceDialogState() {
  const [isOpen, setIsOpen] = useState(false);
  const [parentSourceId, setParentSourceId] = useState<string | null>(null);
  const [tab, setTab] = useState<AddTab>("File");
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  const reset = useCallback(() => {
    setTextTitle("");
    setTextContent("");
    setUrlValue("");
    setUrlTitle("");
    setFiles([]);
    setUploadProgress(0);
    setTab("File");
    setIsDragActive(false);
    setParentSourceId(null);
    dragDepthRef.current = 0;
  }, []);

  const open = useCallback((nextParentSourceId: string | null = null) => {
    setParentSourceId(nextParentSourceId);
    setIsOpen(true);
  }, []);

  const close = useCallback(
    (openState: boolean) => {
      setIsOpen(openState);
      if (!openState) {
        reset();
      }
    },
    [reset],
  );

  const addFiles = useCallback(
    (incoming: File[] | null) => {
      if (!incoming || incoming.length === 0) return;

      const nextFiles = [...files];
      for (const file of incoming) {
        if (!isSupportedUploadFile(file)) {
          toast.error(`"${file.name}" is not a supported source file.`);
          continue;
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
          toast.error(`"${file.name}" exceeds ${MAX_FILE_SIZE_MB}MB.`);
          continue;
        }
        if (nextFiles.length >= MAX_FILES) {
          toast.error(`You can upload up to ${MAX_FILES} files at once.`);
          break;
        }
        nextFiles.push(file);
      }
      setFiles(nextFiles);
    },
    [files],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) =>
      prev.filter((_, currentIndex) => currentIndex !== index),
    );
  }, []);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current += 1;
      setIsDragActive(true);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragActive(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragActive(false);
      dragDepthRef.current = 0;
      addFiles(Array.from(event.dataTransfer.files ?? []));
    },
    [addFiles],
  );

  return {
    addFiles,
    close,
    fileInputRef,
    files,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    isDragActive,
    isOpen,
    open,
    parentSourceId,
    removeFile,
    reset,
    setIsOpen,
    setParentSourceId,
    setTab,
    setTextContent,
    setTextTitle,
    setUploadProgress,
    setUrlTitle,
    setUrlValue,
    tab,
    textContent,
    textTitle,
    uploadProgress,
    urlTitle,
    urlValue,
  };
}

function SkillRow({
  icon,
  skill,
  selected,
  disabled,
  busy,
  onToggle,
  onOpenSkill,
}: {
  icon?: SkillIconSpec;
  skill: HubSkillItem;
  selected: boolean;
  disabled?: boolean;
  busy?: boolean;
  onToggle: (id: string) => void | Promise<void>;
  onOpenSkill: (catalogId: string) => void;
}) {
  function handleRowClick(event: MouseEvent<HTMLElement>) {
    if (disabled) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea,select,a,[role='button']")) {
      return;
    }

    void onToggle(skill.id);
  }

  return (
    <article
      className={cn(
        "group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors",
        selected ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-accent/60",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
        busy && "cursor-wait opacity-70",
      )}
      onClick={handleRowClick}
    >
      <Checkbox
        checked={selected}
        className="mt-0.5"
        disabled={disabled || busy}
        onCheckedChange={() => void onToggle(skill.id)}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <SkillRowIcon icon={icon} selected={selected} />
          <button
            className="cursor-pointer truncate text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => onOpenSkill(skill.catalogId)}
            title="Open skill introduction"
            type="button"
          >
            {skill.displayName}
          </button>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
          {skill.description}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <TypeBadge label={skillSourceLabel(skill.sourceType)} />
          {disabled ? <TypeBadge label="Tool off" /> : null}
          {skill.sourceType !== "builtin" ? (
            <TypeBadge label={selected ? "Hub on" : "Hub off"} />
          ) : null}
        </div>
      </div>
    </article>
  );
}

type SkillIconSpec = Pick<CapabilityCatalogCommand, "iconName" | "iconTone">;

function SkillRowIcon({
  icon,
  selected,
}: {
  icon?: SkillIconSpec;
  selected: boolean;
}) {
  const className = cn(
    "size-3 shrink-0",
    selected ? "text-primary" : "text-muted-foreground",
  );
  if (icon?.iconName) {
    return (
      <GlobalIcon
        className={className}
        fallbackIconName="skill"
        iconName={icon.iconName}
        iconTone={icon.iconTone ?? "mono"}
      />
    );
  }

  return <SkillIcon className={className} />;
}

function SkillsTab({
  skills,
  skillIconsById,
  searchQuery,
  selectedSkillIds,
  onSkillSelectionChange,
  onWorkspaceSkillEnabledChange,
  onOpenSkill,
  disabledToolNames = [],
}: {
  skills: HubSkillItem[];
  skillIconsById?: ReadonlyMap<string, SkillIconSpec>;
  searchQuery: string;
  selectedSkillIds: string[];
  onSkillSelectionChange: (ids: string[]) => void;
  onWorkspaceSkillEnabledChange?: (
    skill: HubSkillItem,
    enabled: boolean,
  ) => void | Promise<void>;
  onOpenSkill: (catalogId: string) => void;
  disabledToolNames?: string[];
}) {
  const [busySkillIds, setBusySkillIds] = useState<Set<string>>(new Set());
  const q = searchQuery.trim().toLowerCase();
  const selectedSet = useMemo(
    () => new Set(selectedSkillIds),
    [selectedSkillIds],
  );
  const disabledToolSet = useMemo(
    () => new Set(disabledToolNames),
    [disabledToolNames],
  );
  const filtered = useMemo(
    () =>
      q
        ? skills.filter(
            (skill) =>
              skill.displayName.toLowerCase().includes(q) ||
              skill.description.toLowerCase().includes(q) ||
              skill.name.toLowerCase().includes(q),
          )
        : skills,
    [q, skills],
  );

  async function toggleSkill(skillId: string) {
    const skill = skills.find((item) => item.id === skillId);
    if (!skill || busySkillIds.has(skillId)) {
      return;
    }
    if (
      skill.sourceType === "builtin" &&
      skill.tools?.some((toolName) => disabledToolSet.has(toolName))
    ) {
      return;
    }
    if (skill.sourceType !== "builtin" && skill.workspaceSkillId) {
      if (!onWorkspaceSkillEnabledChange) {
        return;
      }
      const nextEnabled = !skill.enabled;
      setBusySkillIds((current) => new Set(current).add(skillId));
      try {
        await onWorkspaceSkillEnabledChange(skill, nextEnabled);
      } finally {
        setBusySkillIds((current) => {
          const next = new Set(current);
          next.delete(skillId);
          return next;
        });
      }
      return;
    }
    if (selectedSet.has(skillId)) {
      onSkillSelectionChange(selectedSkillIds.filter((id) => id !== skillId));
      return;
    }
    onSkillSelectionChange([...selectedSkillIds, skillId].slice(0, 5));
  }

  if (filtered.length === 0) {
    return (
      <HubEmptyState
        description={
          searchQuery
            ? "Try a different skill name, slug, description, or source."
            : "Install skills to add reusable creation workflows and agent capabilities to this project."
        }
        icon={SkillIcon}
        title={
          searchQuery
            ? `No installed skills match "${searchQuery}"`
            : "Skills will appear here."
        }
      />
    );
  }

  return (
    <div className="space-y-0.5">
      {filtered.map((skill) => {
        const hasDisabledTool =
          skill.tools?.some((toolName) => disabledToolSet.has(toolName)) ??
          false;
        return (
          <SkillRow
            busy={busySkillIds.has(skill.id)}
            disabled={skill.sourceType === "builtin" && hasDisabledTool}
            icon={skillIconsById?.get(skill.id)}
            key={skill.id}
            onOpenSkill={onOpenSkill}
            onToggle={toggleSkill}
            selected={
              skill.sourceType !== "builtin" && skill.workspaceSkillId
                ? skill.enabled === true
                : selectedSet.has(skill.id)
            }
            skill={skill}
          />
        );
      })}
    </div>
  );
}

function McpRow({
  install,
  selectedInstallIds,
  selectedToolIds,
  onSelectionChange,
}: {
  install: WorkspaceMcpInstall;
  selectedInstallIds: string[];
  selectedToolIds: string[];
  onSelectionChange: (selection: McpToolSelection) => void;
}) {
  const selectedInstallSet = useMemo(
    () => new Set(selectedInstallIds),
    [selectedInstallIds],
  );
  const selectedToolSet = useMemo(
    () => new Set(selectedToolIds),
    [selectedToolIds],
  );
  const disabled =
    !install.enabled ||
    !install.webExecutable ||
    install.desktopOnly ||
    (install.authType !== "none" && install.credentialStatus !== "configured");
  const selected = selectedInstallSet.has(install.id);
  const enabledTools = install.tools.filter((tool) => tool.enabled);
  const selectedToolCount = enabledTools.filter((tool) =>
    selectedToolSet.has(tool.id),
  ).length;

  function emit(nextInstallIds: string[], nextToolIds = selectedToolIds) {
    onSelectionChange({
      enabled: nextInstallIds.length > 0 || nextToolIds.length > 0,
      installIds: nextInstallIds,
      toolIds: nextToolIds,
    });
  }

  function toggleInstall() {
    if (disabled) return;
    if (selected) {
      emit(
        selectedInstallIds.filter((id) => id !== install.id),
        selectedToolIds.filter(
          (id) => !enabledTools.some((tool) => tool.id === id),
        ),
      );
      return;
    }
    emit([...selectedInstallIds, install.id], selectedToolIds);
  }

  function toggleTool(toolId: string) {
    if (disabled || selected) return;
    const nextToolIds = selectedToolSet.has(toolId)
      ? selectedToolIds.filter((id) => id !== toolId)
      : [...selectedToolIds, toolId];
    emit(selectedInstallIds, nextToolIds);
  }

  return (
    <article
      className={cn(
        "rounded-md px-2 py-2 transition-colors",
        selected || selectedToolCount > 0
          ? "bg-primary/5"
          : "hover:bg-accent/60",
        disabled && "opacity-55",
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={selected}
          className="mt-0.5"
          disabled={disabled}
          onCheckedChange={toggleInstall}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <McpIcon
              className={cn(
                "size-3 shrink-0",
                selected ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {install.name}
            </span>
            <TypeBadge
              label={
                install.official
                  ? "Official"
                  : install.verified
                    ? "Verified"
                    : "Unverified"
              }
            />
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
            {install.summary}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <TypeBadge label={install.transport.replaceAll("_", " ")} />
            {install.authType !== "none" ? (
              <TypeBadge
                label={
                  install.credentialStatus === "configured"
                    ? "Auth configured"
                    : "Auth required"
                }
              />
            ) : null}
            {!install.webExecutable || install.desktopOnly ? (
              <TypeBadge label="Desktop only" />
            ) : null}
            {!install.enabled ? <TypeBadge label="Disabled" /> : null}
          </div>
        </div>
      </div>

      {enabledTools.length > 0 ? (
        <div className="mt-2 space-y-1 pl-6">
          {enabledTools.slice(0, 8).map((tool) => (
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-accent/60",
                (disabled || selected) &&
                  "cursor-not-allowed hover:bg-transparent",
              )}
              key={tool.id}
            >
              <Checkbox
                checked={selected || selectedToolSet.has(tool.id)}
                className="mt-0.5 size-3.5"
                disabled={disabled || selected}
                onCheckedChange={() => toggleTool(tool.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">
                  {tool.title ?? tool.serverToolName}
                </span>
                {tool.description ? (
                  <span className="line-clamp-1 text-[10px] text-muted-foreground">
                    {tool.description}
                  </span>
                ) : null}
              </span>
              <TypeBadge label={tool.risk} />
            </label>
          ))}
          {enabledTools.length > 8 ? (
            <div className="px-1.5 text-[10px] text-muted-foreground">
              {enabledTools.length - 8} more tools are available when the server
              is selected.
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function McpTab({
  installs,
  isLoading,
  loadingError,
  onRefresh,
  onSelectionChange,
  searchQuery,
  selectedInstallIds,
  selectedToolIds,
}: {
  installs: WorkspaceMcpInstall[];
  isLoading: boolean;
  loadingError: string | null;
  onRefresh: () => void;
  onSelectionChange: (selection: McpToolSelection) => void;
  searchQuery: string;
  selectedInstallIds: string[];
  selectedToolIds: string[];
}) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? installs.filter(
            (install) =>
              install.name.toLowerCase().includes(q) ||
              install.summary.toLowerCase().includes(q) ||
              install.tools.some(
                (tool) =>
                  tool.serverToolName.toLowerCase().includes(q) ||
                  (tool.title ?? "").toLowerCase().includes(q) ||
                  (tool.description ?? "").toLowerCase().includes(q),
              ),
          )
        : installs,
    [installs, q],
  );

  if (loadingError) {
    return (
      <HubEmptyState
        description={loadingError}
        icon={CircleAlert}
        title="MCP tools could not be loaded."
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
        Loading MCP tools...
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <HubEmptyState
        description={
          searchQuery
            ? "Try a different server, tool, or description."
            : "Install MCP servers from the MCP Market to use them in chat."
        }
        icon={McpIcon}
        title={
          searchQuery
            ? `No MCP tools match "${searchQuery}"`
            : "No MCP tools installed."
        }
      />
    );
  }

  return (
    <div className="space-y-1">
      <div className="mb-2 flex justify-end">
        <Button
          onClick={onRefresh}
          size="icon-xs"
          title="Refresh MCP tools"
          type="button"
          variant="ghost"
        >
          <RotateCcw className="size-3.5" />
          <span className="sr-only">Refresh MCP tools</span>
        </Button>
      </div>
      {filtered.map((install) => (
        <McpRow
          install={install}
          key={install.id}
          onSelectionChange={onSelectionChange}
          selectedInstallIds={selectedInstallIds}
          selectedToolIds={selectedToolIds}
        />
      ))}
    </div>
  );
}

function formatConnectorDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function formatConnectorSchedule(connector: SourceConnector) {
  if (!connector.periodicIndexingEnabled) {
    return "Manual sync";
  }
  const minutes = connector.indexingFrequencyMinutes;
  if (!minutes) {
    return "Auto sync";
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `Auto sync every ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Auto sync every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `Auto sync every ${minutes} min`;
}

function getConnectorFrequencyFormState(connector: SourceConnector) {
  if (!connector.periodicIndexingEnabled) {
    return {
      frequencyValue: "manual",
      customFrequencyMinutes:
        connector.indexingFrequencyMinutes?.toString() ?? "360",
    };
  }

  const minutes = connector.indexingFrequencyMinutes ?? 360;
  const value = minutes.toString();
  if (connectorSyncFrequencyPresetValues.has(value)) {
    return {
      frequencyValue: value,
      customFrequencyMinutes: value,
    };
  }
  return {
    frequencyValue: "custom",
    customFrequencyMinutes: value,
  };
}

function connectorCatalogMatches(
  item: ConnectorCatalogItem,
  searchQuery: string,
) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  return [
    item.name,
    item.category,
    item.description,
    item.connectMode,
    ...item.capabilities,
  ].some((value) => value.toLowerCase().includes(q));
}

function connectorMatchesSearch(connector: ConnectorItem, searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  return [
    getConnectorDisplayName(connector),
    getConnectorAccountLabel(connector),
    connector.name,
    connector.status,
    connector.meta,
    connector.raw.connectorType,
    connector.raw.lastError ?? "",
  ].some((value) => (value ?? "").toLowerCase().includes(q));
}

function statusTone(status: ConnectorCatalogStatusKind) {
  if (status === "active")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "syncing")
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "connected" || status === "available")
    return "border-primary/30 bg-primary/10 text-primary";
  if (status === "needs_setup")
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "error")
    return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted/50 text-muted-foreground";
}

function statusIcon(status: ConnectorCatalogStatusKind) {
  if (status === "active") return CheckCircle2;
  if (status === "syncing") return Loader2;
  if (status === "needs_setup") return Webhook;
  if (status === "error") return CircleAlert;
  if (status === "coming_soon") return Clock3;
  return PlugIcon;
}

function PlugIcon({ className }: { className?: string }) {
  return <Link2 className={className} />;
}

function getConnectorProviderName(connectorType: string) {
  return (
    connectorCatalog.find((item) => item.id === connectorType)?.name ??
    connectorType
  );
}

function getConnectorDisplayName(connector: ConnectorItem) {
  const providerName = getConnectorProviderName(connector.raw.connectorType);
  const accountLabel = getConnectorAccountLabel(connector);
  return accountLabel ? `${accountLabel} - ${providerName}` : providerName;
}

function getConnectorAccountLabel(connector: ConnectorItem) {
  const providerName = getConnectorProviderName(connector.raw.connectorType);
  const normalizedProviderName = providerName.toLowerCase();
  const name = connector.name.trim();
  if (!name || name.toLowerCase() === normalizedProviderName) {
    return null;
  }
  const displaySuffix = ` - ${providerName}`;
  if (name.toLowerCase().endsWith(displaySuffix.toLowerCase())) {
    const accountLabel = name.slice(0, -displaySuffix.length).trim();
    return accountLabel || null;
  }
  return name;
}

function compactConnectorProviderMeta(connector: ConnectorItem) {
  const schedule = formatConnectorSchedule(connector.raw);
  return schedule;
}

function compactConnectorExecutionMeta(connector: ConnectorItem) {
  const providerName = getConnectorProviderName(connector.raw.connectorType);
  const lastSync = connector.raw.lastIndexedAt
    ? `Last sync ${new Date(connector.raw.lastIndexedAt).toLocaleString()}`
    : "Never synced";
  return [providerName, lastSync].filter(Boolean).join(" · ");
}

function formatConnectorReadinessSummary(
  readiness: ConnectorReadinessState | null,
) {
  if (!readiness) {
    return null;
  }
  return (
    syncReadinessUiByReason[readiness.reason]?.summary ??
    readiness.message ??
    "Connected · Setup required"
  );
}

function shouldSurfaceWebhookSetupStatus(
  readiness: ConnectorReadinessState | null,
) {
  if (!readiness) {
    return true;
  }
  return !syncReadinessUiByReason[readiness.reason]?.suppressWebhookSetup;
}

function getConnectorReadinessFromConfig(
  connector: SourceConnector,
): ConnectorReadinessState | null {
  const state = connector.configJson.syncReadiness;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const record = state as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason : "";
  const message = typeof record.message === "string" ? record.message : "";
  if (!reason) {
    return null;
  }
  return {
    reason,
    message: message || "Connector is not ready to sync.",
  };
}

function getCatalogConnector(
  item: ConnectorCatalogItem,
  connectors: ConnectorItem[],
) {
  if (item.connectMode !== "oauth_connector") return null;
  return (
    connectors.find((connector) => connector.raw.connectorType === item.id) ??
    null
  );
}

function getOAuthConnectorStatus(input: {
  connector: ConnectorItem | null;
  hasActiveAccount: boolean;
  isBusy: boolean;
  item: ConnectorCatalogItem;
  readiness?: ConnectorReadinessState | null;
  webhookConfig: ConnectorWebhookConfig | null;
}): ConnectorCatalogStatus {
  if (input.isBusy) {
    return {
      kind: "syncing",
      label: "Syncing",
      detail: "A connector operation is running.",
    };
  }

  const connector = input.connector;
  if (connector) {
    if (connector.status === "disabled") {
      return {
        kind: "needs_setup",
        label: "Disabled",
        detail: "Syncing is disabled. Enable this connector to resume.",
      };
    }
    if (connector.status === "error" || connector.raw.lastError) {
      return {
        kind: "error",
        label: "Error",
        detail: connector.raw.lastError || "Connector needs attention.",
      };
    }
    if (connector.status === "paused") {
      return {
        kind: "needs_setup",
        label: "Paused",
        detail: "Syncing is paused until you resume this connector.",
      };
    }
    if (
      input.item.supportsWebhook &&
      shouldSurfaceWebhookSetupStatus(input.readiness ?? null) &&
      input.webhookConfig &&
      !input.webhookConfig.isConfigured
    ) {
      return {
        kind: "needs_setup",
        label: "Needs setup",
        detail: "Configure a public HTTPS webhook endpoint.",
      };
    }
    return {
      kind: "active",
      label: "Active",
      detail:
        formatConnectorReadinessSummary(input.readiness ?? null) ??
        `Last sync ${formatConnectorDate(connector.raw.lastIndexedAt)}`,
    };
  }

  if (input.hasActiveAccount) {
    return {
      kind: "connected",
      label: "Connected",
      detail:
        input.item.postOAuthMode === "auto_create"
          ? "Authorization exists without an active connector. Reconnect to create a connector."
          : "OAuth is connected. Configure this connector to enable syncing.",
    };
  }

  return {
    kind: "available",
    label: "Available",
    detail: `Ready to connect with ${input.item.name} OAuth.`,
  };
}

function getCatalogStatus(input: {
  item: ConnectorCatalogItem;
  connectors: ConnectorItem[];
  accounts: ConnectorAccountItem[];
  connectorBusyById: Record<string, boolean>;
  connectorWaitingByType: Record<string, boolean>;
  connectorReadinessById?: Record<string, ConnectorReadinessState>;
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
}): ConnectorCatalogStatus {
  if (input.item.connectMode === "coming_soon") {
    if (input.item.statusKind === "non_indexable") {
      return {
        kind: "coming_soon",
        label: "Search API",
        detail: "Non-indexable connector for live agent search.",
      };
    }
    if (input.item.statusKind === "indexable") {
      return {
        kind: "coming_soon",
        label: "Indexable",
        detail: "Indexable data source connector on the roadmap.",
      };
    }
    return {
      kind: "coming_soon",
      label: "Coming soon",
      detail: input.item.isIndexable
        ? "Indexable data source connector on the roadmap."
        : "Non-indexable connector on the roadmap.",
    };
  }
  const connector = getCatalogConnector(input.item, input.connectors);
  const hasActiveAccount = input.accounts.some(
    (account) =>
      account.connectorType === input.item.id && account.status === "active",
  );
  return getOAuthConnectorStatus({
    connector,
    hasActiveAccount: hasActiveAccount && !connector,
    isBusy: Boolean(
      input.connectorWaitingByType[input.item.id] ||
        (connector && input.connectorBusyById[connector.id]),
    ),
    item: input.item,
    readiness: connector
      ? (input.connectorReadinessById?.[connector.id] ?? null)
      : null,
    webhookConfig: connector
      ? (input.webhookConfigsById[connector.id] ?? null)
      : null,
  });
}

function ConnectorStatusBadge({ status }: { status: ConnectorCatalogStatus }) {
  const Icon = statusIcon(status.kind);
  return (
    <Badge
      className={cn(
        "h-5 max-w-full gap-1 border px-1.5 text-[10px]",
        statusTone(status.kind),
      )}
      variant="outline"
    >
      <Icon
        className={cn("size-3", status.kind === "syncing" && "animate-spin")}
      />
      {status.label}
    </Badge>
  );
}

function activityTone(status: string) {
  if (status === "succeeded" || status === "processed") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "running" || status === "queued" || status === "received") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (status === "skipped" || status === "ignored") {
    return "border-border bg-muted/50 text-muted-foreground";
  }
  if (status === "failed" || status === "error") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted/50 text-muted-foreground";
}

function ActivityStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      className={cn("h-5 border px-1.5 text-[10px]", activityTone(status))}
      variant="outline"
    >
      {status}
    </Badge>
  );
}

const connectorActivitySummaryLabels: Record<string, string> = {
  actionType: "Action",
  attempts: "Attempts",
  discoveredCount: "Discovered",
  eventType: "Event",
  externalId: "External ID",
  failedCount: "Failed",
  fullResync: "Full resync",
  heartbeatAt: "Heartbeat",
  indexedCount: "Indexed",
  objectId: "Object ID",
  objectType: "Object",
  providerEventId: "Provider event",
  reason: "Reason",
  requestPreview: "Request",
  riskLevel: "Risk",
  source: "Source",
  targetExternalIds: "Targets",
  targetExternalIdCount: "Target count",
  targeted: "Targeted",
  syncRunId: "Linked sync",
  triggerType: "Trigger",
};

const hiddenConnectorActivitySummaryKeys = new Set([
  "approvedBy",
  "createdBy",
  "executedBy",
]);

function formatConnectorActivityTitle(item: ConnectorActivityItem) {
  if (item.kind === "sync") {
    const trigger =
      typeof item.summaryJson.triggerType === "string"
        ? item.summaryJson.triggerType
        : "connector";
    const triggerLabel =
      trigger === "manual"
        ? "Manual"
        : trigger === "scheduled"
          ? "Scheduled"
          : trigger === "webhook"
            ? "Webhook"
            : trigger === "backfill"
              ? "Backfill"
              : trigger;
    return `${triggerLabel} sync`;
  }
  if (item.kind === "action") {
    return typeof item.summaryJson.actionType === "string"
      ? item.summaryJson.actionType
      : "Connector action";
  }
  if (item.kind === "webhook") {
    return typeof item.summaryJson.eventType === "string"
      ? item.summaryJson.eventType
      : "Webhook event";
  }
  return item.title;
}

function formatConnectorActivityValue(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(date.getTime())) {
      return date.toLocaleString();
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "None";
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function ActivityRow({ item }: { item: ConnectorActivityItem }) {
  const Icon =
    item.kind === "sync"
      ? RotateCcw
      : item.kind === "action"
        ? Sparkles
        : Webhook;
  const summaryEntries = Object.entries(item.summaryJson)
    .filter(
      ([key, value]) =>
        !hiddenConnectorActivitySummaryKeys.has(key) &&
        value !== null &&
        value !== undefined,
    )
    .slice(0, 6);
  return (
    <div className="rounded-lg border bg-background p-2.5 text-xs">
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/25">
          <Icon className="size-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {formatConnectorActivityTitle(item)}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {new Date(item.createdAt).toLocaleString()} ·{" "}
                {formatDuration(item.durationMs)}
              </p>
            </div>
            <ActivityStatusBadge status={item.status} />
          </div>
          {summaryEntries.length > 0 ? (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
              {summaryEntries.map(([key, value]) => (
                <div
                  className="min-w-0 rounded-md bg-muted/35 px-2 py-1"
                  key={key}
                >
                  <span className="block text-[10px] text-muted-foreground">
                    {connectorActivitySummaryLabels[key] ?? key}
                  </span>
                  <span className="block truncate text-[11px] text-foreground">
                    {formatConnectorActivityValue(value)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {item.errorMessage ? (
            <Alert className="mt-2" variant="destructive">
              <AlertDescription>{item.errorMessage}</AlertDescription>
            </Alert>
          ) : null}
          {Object.keys(item.resultJson).length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                Execution result
              </summary>
              <pre className="mt-2 max-h-44 overflow-auto rounded-md bg-muted/45 p-2 text-[10px] leading-4 text-muted-foreground">
                {formatJsonPreview(item.resultJson)}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActivityList({
  description,
  emptyTitle,
  items,
  kind,
  loading,
  loadingError,
}: {
  description: string;
  emptyTitle: string;
  items: ConnectorActivityItem[];
  kind: ConnectorActivityKindFilter;
  loading: boolean;
  loadingError: string | null;
}) {
  const filtered =
    kind === "all" ? items : items.filter((item) => item.kind === kind);
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      {loading ? (
        <div className="flex items-center justify-center rounded-lg border bg-muted/20 py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Loading activity...
        </div>
      ) : null}
      {loadingError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadingError}</AlertDescription>
        </Alert>
      ) : null}
      {!loading && !loadingError && filtered.length === 0 ? (
        <HubEmptyState
          description="Connector activity will appear here after syncs, actions, or webhooks run."
          icon={Clock3}
          title={emptyTitle}
        />
      ) : null}
      {filtered.map((item) => (
        <ActivityRow item={item} key={`${item.kind}:${item.id}`} />
      ))}
    </div>
  );
}

function ConnectorLogo({
  icon: Icon,
  logoIconName,
  logoIconTone,
  logoSrc,
  label,
  active,
  className,
}: {
  icon: ConnectorIcon;
  logoIconName?: GlobalIconName;
  logoIconTone?: GlobalIconTone;
  logoSrc?: string;
  label?: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs",
        active && "border-primary/40 bg-primary/5 text-primary",
        className,
      )}
    >
      {logoIconName ? (
        <GlobalIcon
          className="size-6"
          fallbackIconName="tool"
          iconName={logoIconName}
          iconTone={logoIconTone ?? "brand"}
        />
      ) : logoSrc ? (
        <RawImage
          alt=""
          aria-hidden="true"
          className="size-6 object-contain"
          src={logoSrc}
          title={label}
        />
      ) : (
        <Icon className="size-4" />
      )}
    </div>
  );
}

const ConnectorCatalogCard = memoComponent(function ConnectorCatalogCard({
  item,
  status,
  connector,
  onCancelConnector,
  onConfigure,
  onConnectConnector,
  onCreateConnector,
  onDisconnect,
  onRequestConnector,
}: {
  item: ConnectorCatalogItem;
  status: ConnectorCatalogStatus;
  connector: ConnectorItem | null;
  onCancelConnector: (item: ConnectorCatalogItem) => void;
  onConfigure: () => void;
  onConnectConnector: (item: ConnectorCatalogItem) => void;
  onCreateConnector: (item: ConnectorCatalogItem) => void;
  onDisconnect: (connector: ConnectorItem) => void;
  onRequestConnector: (item: ConnectorCatalogItem) => void;
}) {
  const isBusy = status.kind === "syncing";
  const cta =
    item.connectMode === "coming_soon"
      ? "Request"
      : isBusy
        ? "Connecting..."
        : connector
          ? "Connected"
          : status.kind === "connected" && item.postOAuthMode !== "auto_create"
            ? "Configure"
            : "Connect";

  function handleAction() {
    if (item.connectMode === "coming_soon") {
      onRequestConnector(item);
      return;
    }
    if (connector) {
      return;
    }
    if (status.kind === "connected" && item.postOAuthMode !== "auto_create") {
      onCreateConnector(item);
      return;
    }
    onConnectConnector(item);
  }

  return (
    <article
      className={cn(
        "group flex min-h-[96px] flex-col justify-between rounded-lg border bg-background p-2.5 shadow-xs transition-colors hover:bg-accent/30",
        status.kind === "error" && "border-destructive/30",
      )}
    >
      <div className="flex items-start gap-2.5">
        <ConnectorLogo
          active={status.kind === "active" || status.kind === "connected"}
          icon={item.icon}
          label={item.name}
          logoIconName={item.logoIconName}
          logoIconTone={item.logoIconTone}
          logoSrc={item.logoSrc}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-1.5">
            <div className="min-w-0">
              <h4 className="truncate text-sm font-medium text-foreground">
                {item.name}
              </h4>
              <p className="mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground">
                {item.description}
              </p>
            </div>
            <div className="flex shrink-0 items-start gap-1">
              <div className="hidden max-w-[120px] sm:block">
                <ConnectorStatusBadge status={status} />
              </div>
              {connector ? (
                <Button
                  className="size-7 text-destructive opacity-80 hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                  disabled={isBusy}
                  onClick={() => onDisconnect(connector)}
                  size="icon-xs"
                  title={`Disconnect ${item.name}`}
                  type="button"
                  variant="ghost"
                >
                  <Power className="size-3.5" />
                  <span className="sr-only">Disconnect {item.name}</span>
                </Button>
              ) : null}
            </div>
          </div>
          <div className="mt-1.5 hidden flex-wrap gap-1 sm:flex">
            <TypeBadge label={item.isIndexable ? "Indexable" : "Search API"} />
            {item.capabilities.slice(0, 2).map((capability) => (
              <TypeBadge key={capability} label={capability} />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-[10px] text-muted-foreground">
          {status.detail}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {connector ? (
            <Button
              className="size-7"
              onClick={onConfigure}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Settings2 className="size-3.5" />
              <span className="sr-only">Configure {item.name}</span>
            </Button>
          ) : null}
          {isBusy ? (
            <Button
              className="h-7 px-2 text-[11px]"
              onClick={() => onCancelConnector(item)}
              size="sm"
              type="button"
              variant="outline"
            >
              <X className="size-3.5" />
              Cancel
            </Button>
          ) : null}
          <Button
            className="shrink-0"
            disabled={isBusy || Boolean(connector)}
            onClick={handleAction}
            size="xs"
            type="button"
            variant={
              connector || status.kind === "coming_soon" ? "outline" : "default"
            }
          >
            {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {cta}
          </Button>
        </div>
      </div>
    </article>
  );
});

const ActiveConnectorCard = memoComponent(function ActiveConnectorCard({
  connector,
  connectorBusyById,
  connectorReadinessById,
  webhookConfig,
  webhookEvents,
  onCopyWebhook,
  onDisconnect,
  onBackToCatalog,
  onOpenSettings,
  onSyncConnector,
  onToggleStatus,
}: {
  connector: ConnectorItem;
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  webhookConfig: ConnectorWebhookConfig | null;
  webhookEvents: ConnectorWebhookEventItem[];
  onCopyWebhook: (value: string) => void;
  onDisconnect: (connector: ConnectorItem) => void;
  onBackToCatalog?: () => void;
  onOpenSettings: (connector: ConnectorItem) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleStatus: (connector: ConnectorItem) => void;
}) {
  const isBusy = Boolean(connectorBusyById[connector.id]);
  const catalogItem =
    connectorCatalog.find((item) => item.id === connector.raw.connectorType) ??
    connectorCatalog.find((item) => item.id === "notion");
  const icon = catalogItem?.icon ?? Link2;
  const status = getOAuthConnectorStatus({
    connector,
    hasActiveAccount: true,
    isBusy,
    item: catalogItem ?? {
      id: connector.raw.connectorType,
      name: connector.raw.connectorType,
      category: "Knowledge & Docs",
      description: connector.meta,
      capabilities: [],
      connectMode: "oauth_connector",
      postOAuthMode: "configure_required",
      icon: Link2,
      isIndexable: true,
      authKind: "oauth",
      supportsPeriodicSync: true,
      supportsActions: false,
      supportsWebhook: false,
      statusKind: "coming_soon",
    },
    readiness: connectorReadinessById[connector.id] ?? null,
    webhookConfig: catalogItem?.supportsWebhook ? webhookConfig : null,
  });
  const statusToggleLabel =
    connector.status === "disabled"
      ? "Enable"
      : connector.status === "paused"
        ? "Resume"
        : "Pause";
  const StatusToggleIcon =
    connector.status === "disabled" || connector.status === "paused"
      ? Play
      : PowerOff;
  const providerName = getConnectorDisplayName(connector);

  return (
    <article className="rounded-lg border bg-background p-2.5 shadow-xs">
      {onBackToCatalog ? (
        <div className="mb-2">
          <Button
            className="h-7 px-2 text-[11px]"
            onClick={onBackToCatalog}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="size-3.5" />
            Back to catalog
          </Button>
        </div>
      ) : null}
      <div className="flex items-start gap-2.5">
        <ConnectorLogo
          active={connector.status === "active"}
          icon={icon}
          label={providerName}
          logoIconName={catalogItem?.logoIconName}
          logoIconTone={catalogItem?.logoIconTone}
          logoSrc={catalogItem?.logoSrc}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="min-w-0">
                <button
                  className="block max-w-full truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => onOpenSettings(connector)}
                  title={`Open ${providerName} settings`}
                  type="button"
                >
                  {providerName}
                </button>
              </h4>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {compactConnectorExecutionMeta(connector)}
              </p>
            </div>
            <div className="hidden shrink-0 sm:block">
              <ConnectorStatusBadge status={status} />
            </div>
            <Button
              className="size-7 shrink-0"
              onClick={() => onOpenSettings(connector)}
              size="icon-xs"
              title={`Open ${providerName} settings`}
              type="button"
              variant="ghost"
            >
              <Settings2 className="size-3.5" />
              <span className="sr-only">Open {providerName} settings</span>
            </Button>
          </div>
          {connector.raw.lastError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>{connector.raw.lastError}</AlertDescription>
            </Alert>
          ) : null}
          {catalogItem?.supportsWebhook && webhookConfig ? (
            <div className="mt-3 rounded-lg border bg-muted/25 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <Webhook className="size-3.5" />
                  Webhook URL
                </span>
                {!webhookConfig.isConfigured ? (
                  <Badge
                    className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                    variant="outline"
                  >
                    local
                  </Badge>
                ) : null}
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1 text-[10px] text-muted-foreground">
                  {webhookConfig.webhookUrl}
                </code>
                <Button
                  className="size-7"
                  onClick={() => onCopyWebhook(webhookConfig.webhookUrl)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Copy className="size-3.5" />
                  <span className="sr-only">Copy webhook URL</span>
                </Button>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                Add this URL in {providerName} connection settings after OAuth
                is complete. Provider webhooks require public HTTPS.
              </p>
              {catalogItem?.webhookSupportNote ? (
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  {catalogItem.webhookSupportNote}
                </p>
              ) : null}
              {webhookEvents.length > 0 ? (
                <div className="mt-2 space-y-1 border-t pt-2">
                  {webhookEvents.slice(0, 3).map((event) => (
                    <div
                      className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                      key={event.id}
                    >
                      <span className="truncate">{event.eventType}</span>
                      <span className="shrink-0">{event.status}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          className={disabledConnectorIconButtonClass}
          disabled={connector.status === "disabled" || isBusy}
          onClick={() => onSyncConnector(connector)}
          size="xs"
          title={
            connector.status === "paused"
              ? `Sync paused ${providerName} manually`
              : connector.status === "disabled"
                ? `${providerName} is disabled`
                : `Sync ${providerName}`
          }
          type="button"
          variant="outline"
        >
          {isBusy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          Sync now
        </Button>
        <Button
          className={disabledConnectorIconButtonClass}
          disabled={isBusy}
          onClick={() => onToggleStatus(connector)}
          size="xs"
          title={`${statusToggleLabel} ${providerName}`}
          type="button"
          variant="outline"
        >
          <StatusToggleIcon className="size-3.5" />
          {statusToggleLabel}
        </Button>
        <Button
          className={disabledConnectorIconButtonClass}
          disabled={isBusy}
          onClick={() => onDisconnect(connector)}
          size="xs"
          title={`Remove ${providerName}`}
          type="button"
          variant="ghost"
        >
          <Power className="size-3.5" />
          Remove
        </Button>
      </div>
    </article>
  );
});

function ConnectorSettingsDialog({
  activity,
  activityError,
  connector,
  connectorBusyById,
  connectorReadinessById,
  isLoadingActivity,
  onCopyWebhook,
  onDisconnect,
  onOpenChange,
  onSaveSettings,
  onSyncConnector,
  onToggleStatus,
  open,
  webhookConfig,
}: {
  activity: ConnectorActivityItem[];
  activityError: string | null;
  connector: ConnectorItem | null;
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  isLoadingActivity: boolean;
  onCopyWebhook: (value: string) => void;
  onDisconnect: (connector: ConnectorItem) => void;
  onOpenChange: (open: boolean) => void;
  onSaveSettings: (
    connector: ConnectorItem,
    input: {
      name: string;
      periodicIndexingEnabled: boolean;
      indexingFrequencyMinutes: number | null;
    },
  ) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleStatus: (connector: ConnectorItem) => void;
  open: boolean;
  webhookConfig: ConnectorWebhookConfig | null;
}) {
  const [tab, setTab] = useState<ConnectorSettingsTab>("overview");
  const connectorType = connector?.raw.connectorType ?? "connector";
  const catalogItem =
    connectorCatalog.find((item) => item.id === connectorType) ?? null;
  const providerName = connector
    ? getConnectorDisplayName(connector)
    : connectorType;
  const isBusy = connector ? Boolean(connectorBusyById[connector.id]) : false;
  const readiness = connector
    ? (connectorReadinessById[connector.id] ??
      getConnectorReadinessFromConfig(connector.raw))
    : null;
  const latestActivity = activity[0] ?? null;
  const latestSuccessfulSync = activity.find(
    (item) => item.kind === "sync" && item.status === "succeeded",
  );
  const overviewStatus = connector?.raw.lastError
    ? "Needs attention"
    : (formatConnectorReadinessSummary(readiness) ?? connector?.status);
  const statusToggleLabel =
    connector?.status === "disabled"
      ? "Enable"
      : connector?.status === "paused"
        ? "Resume"
        : "Pause";
  const StatusToggleIcon =
    connector?.status === "disabled" || connector?.status === "paused"
      ? Play
      : PowerOff;
  const initialFrequencyState = connector
    ? getConnectorFrequencyFormState(connector.raw)
    : { frequencyValue: "manual", customFrequencyMinutes: "360" };
  const [settingsName, setSettingsName] = useState(connector?.name ?? "");
  const [frequencyValue, setFrequencyValue] = useState(
    initialFrequencyState.frequencyValue,
  );
  const [customFrequencyMinutes, setCustomFrequencyMinutes] = useState(
    initialFrequencyState.customFrequencyMinutes,
  );
  const canUsePeriodicSync = catalogItem?.isIndexable ?? true;
  const isSavingSettings = isBusy;

  useEffect(() => {
    if (open) {
      setTab("overview");
    }
  }, [open, connector?.id]);

  useEffect(() => {
    if (!connector) return;
    const next = getConnectorFrequencyFormState(connector.raw);
    setSettingsName(connector.name);
    setFrequencyValue(next.frequencyValue);
    setCustomFrequencyMinutes(next.customFrequencyMinutes);
  }, [connector]);

  if (!connector) {
    return null;
  }

  const parsedCustomFrequency = Number(customFrequencyMinutes);
  const hasValidCustomFrequency =
    Number.isInteger(parsedCustomFrequency) && parsedCustomFrequency > 0;
  const isSettingsValid =
    settingsName.trim().length > 0 &&
    (frequencyValue !== "custom" || hasValidCustomFrequency);
  const settingsChanged =
    settingsName.trim() !== connector.name ||
    (frequencyValue === "manual" && connector.raw.periodicIndexingEnabled) ||
    (frequencyValue !== "manual" &&
      (!connector.raw.periodicIndexingEnabled ||
        (frequencyValue === "custom"
          ? parsedCustomFrequency
          : Number(frequencyValue)) !==
          connector.raw.indexingFrequencyMinutes));

  function handleSaveSettings() {
    const currentConnector = connector;
    if (!currentConnector) {
      return;
    }
    if (!isSettingsValid) {
      toast.error("Enter a connector name and a positive sync interval.");
      return;
    }
    if (!canUsePeriodicSync && frequencyValue !== "manual") {
      toast.error("This connector cannot use periodic sync.");
      return;
    }
    const periodicIndexingEnabled = frequencyValue !== "manual";
    const indexingFrequencyMinutes = periodicIndexingEnabled
      ? frequencyValue === "custom"
        ? parsedCustomFrequency
        : Number(frequencyValue)
      : null;
    onSaveSettings(currentConnector, {
      name: settingsName.trim(),
      periodicIndexingEnabled,
      indexingFrequencyMinutes,
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid h-[min(860px,calc(100svh-1rem))] w-[min(960px,calc(100vw-1rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b px-4 py-3 pr-11 text-left sm:px-5 sm:py-4 sm:pr-12">
          <div className="flex min-w-0 items-start gap-3">
            <ConnectorLogo
              active={connector.status === "active"}
              icon={catalogItem?.icon ?? Link2}
              label={providerName}
              logoIconName={catalogItem?.logoIconName}
              logoIconTone={catalogItem?.logoIconTone}
              logoSrc={catalogItem?.logoSrc}
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-lg sm:text-xl">
                  {providerName}
                </DialogTitle>
                {catalogItem ? (
                  <TypeBadge
                    label={catalogItem.isIndexable ? "Indexable" : "Search API"}
                  />
                ) : null}
              </div>
              <DialogDescription className="mt-1 text-xs leading-5 sm:text-sm">
                Connector settings, execution history, and provider events.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Tabs
          className="min-h-0 gap-0"
          onValueChange={(value) => setTab(value as ConnectorSettingsTab)}
          value={tab}
        >
          <div className="border-b px-4 py-2 sm:px-5">
            <div className="sm:hidden">
              <Select
                onValueChange={(value) => setTab(value as ConnectorSettingsTab)}
                value={tab}
              >
                <SelectTrigger className="w-full" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="overview">Overview</SelectItem>
                  <SelectItem value="configuration">Configuration</SelectItem>
                  <SelectItem value="sync">Sync History</SelectItem>
                  <SelectItem value="actions">Actions</SelectItem>
                  <SelectItem value="webhooks">Webhooks</SelectItem>
                  <SelectItem value="danger">Danger Zone</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ScrollArea className="hidden sm:block">
              <TabsList className="w-max" variant="line">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="configuration">Configuration</TabsTrigger>
                <TabsTrigger value="sync">Sync History</TabsTrigger>
                <TabsTrigger value="actions">Actions</TabsTrigger>
                <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
                <TabsTrigger value="danger">Danger Zone</TabsTrigger>
              </TabsList>
            </ScrollArea>
          </div>

          <ScrollArea className="min-h-0">
            <div className="px-4 py-4 sm:px-5">
              <TabsContent className="m-0 space-y-4" value="overview">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">Status</p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {overviewStatus}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      Last successful sync
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {latestSuccessfulSync
                        ? new Date(
                            latestSuccessfulSync.createdAt,
                          ).toLocaleString()
                        : "Never"}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      Latest run
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {latestActivity
                        ? `${latestActivity.kind} · ${latestActivity.status}`
                        : "No activity"}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      Next scheduled
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {connector.raw.nextScheduledAt
                        ? new Date(
                            connector.raw.nextScheduledAt,
                          ).toLocaleString()
                        : "Not scheduled"}
                    </p>
                  </div>
                </div>
                {readiness ? (
                  <Alert>
                    <AlertDescription>{readiness.message}</AlertDescription>
                  </Alert>
                ) : null}
                {connector.raw.lastError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {connector.raw.lastError}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <ActivityList
                  description="Most recent connector execution records across syncs, actions, and webhooks."
                  emptyTitle="No connector activity yet."
                  items={activity}
                  kind="all"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0 space-y-4" value="configuration">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium text-foreground">
                      General
                    </p>
                    <div className="mt-3 space-y-3">
                      <label className="block space-y-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Name
                        </span>
                        <Input
                          className="h-8 text-xs"
                          disabled={isSavingSettings}
                          onChange={(event) =>
                            setSettingsName(event.target.value)
                          }
                          value={settingsName}
                        />
                      </label>
                      <label className="block space-y-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Sync schedule
                        </span>
                        <Select
                          disabled={!canUsePeriodicSync || isSavingSettings}
                          onValueChange={setFrequencyValue}
                          value={frequencyValue}
                        >
                          <SelectTrigger className="h-8 w-full text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {connectorSyncFrequencyOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                      {frequencyValue === "custom" ? (
                        <label className="block space-y-1.5">
                          <span className="text-[10px] font-medium text-muted-foreground">
                            Custom interval minutes
                          </span>
                          <Input
                            className="h-8 text-xs"
                            disabled={isSavingSettings}
                            min={1}
                            onChange={(event) =>
                              setCustomFrequencyMinutes(event.target.value)
                            }
                            type="number"
                            value={customFrequencyMinutes}
                          />
                        </label>
                      ) : null}
                      {!canUsePeriodicSync ? (
                        <p className="text-[10px] leading-4 text-muted-foreground">
                          Non-indexable search connectors cannot run periodic
                          indexing.
                        </p>
                      ) : null}
                      <Button
                        disabled={
                          isSavingSettings ||
                          !settingsChanged ||
                          !isSettingsValid
                        }
                        onClick={handleSaveSettings}
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        {isSavingSettings ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Settings2 className="size-3.5" />
                        )}
                        Save settings
                      </Button>
                    </div>
                    <dl className="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground">
                      <div className="flex justify-between gap-3">
                        <dt>Schedule</dt>
                        <dd className="truncate text-foreground">
                          {formatConnectorSchedule(connector.raw)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Provider</dt>
                        <dd className="truncate text-foreground">
                          {providerName}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Connection</dt>
                        <dd className="truncate text-foreground">
                          {getConnectorAccountLabel(connector) ??
                            "Default connection"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Account ID</dt>
                        <dd className="truncate text-foreground">
                          {connector.raw.oauthAccountId ?? "None"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium text-foreground">
                      Capabilities
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {catalogItem ? (
                        <>
                          <TypeBadge
                            label={
                              catalogItem.isIndexable
                                ? "Indexable source"
                                : "Non-indexable search"
                            }
                          />
                          {catalogItem.supportsPeriodicSync ? (
                            <TypeBadge label="Periodic sync" />
                          ) : null}
                          {catalogItem.supportsActions ? (
                            <TypeBadge label="Actions" />
                          ) : null}
                          {catalogItem.supportsWebhook ? (
                            <TypeBadge label="Webhooks" />
                          ) : null}
                        </>
                      ) : (
                        <TypeBadge label="Connector" />
                      )}
                    </div>
                  </div>
                </div>
                {catalogItem?.supportsWebhook && webhookConfig ? (
                  <div className="rounded-lg border bg-muted/20 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <Webhook className="size-3.5" />
                        {providerName} webhook URL
                      </span>
                      {!webhookConfig.isConfigured ? (
                        <Badge variant="outline">needs public HTTPS</Badge>
                      ) : null}
                    </div>
                    <div className="mt-2 flex min-w-0 items-center gap-1.5">
                      <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1 text-[10px] text-muted-foreground">
                        {webhookConfig.webhookUrl}
                      </code>
                      <Button
                        className="size-7"
                        onClick={() => onCopyWebhook(webhookConfig.webhookUrl)}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <Copy className="size-3.5" />
                        <span className="sr-only">Copy webhook URL</span>
                      </Button>
                    </div>
                    {catalogItem?.webhookSupportNote ? (
                      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                        {catalogItem.webhookSupportNote} Events are recorded in
                        Webhooks and Activity.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent className="m-0" value="sync">
                <ActivityList
                  description="Manual, scheduled, webhook, backfill, and skipped sync attempts."
                  emptyTitle="No sync runs yet."
                  items={activity}
                  kind="sync"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0" value="actions">
                <ActivityList
                  description="Approved connector writes, updates, deletes, comments, and file uploads."
                  emptyTitle="No connector actions yet."
                  items={activity}
                  kind="action"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0" value="webhooks">
                <ActivityList
                  description="Provider events received from connector webhooks."
                  emptyTitle="No webhook events yet."
                  items={activity}
                  kind="webhook"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0 space-y-3" value="danger">
                <Alert variant="destructive">
                  <AlertDescription>
                    Remove stops this connector from syncing. Indexed sources
                    are kept unless you remove them separately.
                  </AlertDescription>
                </Alert>
                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Button
                    className={disabledConnectorIconButtonClass}
                    disabled={connector.status === "disabled" || isBusy}
                    onClick={() => onSyncConnector(connector)}
                    size="sm"
                    title={
                      connector.status === "paused"
                        ? `Sync paused ${providerName} manually`
                        : connector.status === "disabled"
                          ? `${providerName} is disabled`
                          : `Sync ${providerName}`
                    }
                    type="button"
                    variant="outline"
                  >
                    {isBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    Sync now
                  </Button>
                  <Button
                    className={disabledConnectorIconButtonClass}
                    disabled={isBusy}
                    onClick={() => onToggleStatus(connector)}
                    size="sm"
                    title={`${statusToggleLabel} ${providerName}`}
                    type="button"
                    variant="outline"
                  >
                    <StatusToggleIcon className="size-3.5" />
                    {statusToggleLabel}
                  </Button>
                  <Button
                    className={disabledConnectorIconButtonClass}
                    disabled={isBusy}
                    onClick={() => onDisconnect(connector)}
                    size="sm"
                    title={`Remove ${providerName}`}
                    type="button"
                    variant="destructive"
                  >
                    <Power className="size-3.5" />
                    Remove
                  </Button>
                </div>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ManageConnectorsDialog({
  accounts,
  connectorBusyById,
  connectorReadinessById,
  connectors,
  connectorWaitingByType,
  initialTab,
  isLoading,
  loadingError,
  onCancelConnector,
  onConnectConnector,
  onCopyWebhook,
  onCreateConnector,
  onDisconnectConnector,
  onOpenChange,
  onOpenSettings,
  onRequestConnector,
  onSyncConnector,
  onToggleConnectorStatus,
  open,
  webhookConfigsById,
  webhookEventsByConnectorId,
}: {
  accounts: ConnectorAccountItem[];
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  connectors: ConnectorItem[];
  connectorWaitingByType: Record<string, boolean>;
  initialTab: ManageConnectorsTab;
  isLoading: boolean;
  loadingError: string | null;
  onCancelConnector: (item: ConnectorCatalogItem) => void;
  onConnectConnector: (item: ConnectorCatalogItem) => void;
  onCopyWebhook: (value: string) => void;
  onCreateConnector: (item: ConnectorCatalogItem) => void;
  onDisconnectConnector: (connector: ConnectorItem) => void;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: (connector: ConnectorItem) => void;
  onRequestConnector: (item: ConnectorCatalogItem) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleConnectorStatus: (connector: ConnectorItem) => void;
  open: boolean;
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
  webhookEventsByConnectorId: Record<string, ConnectorWebhookEventItem[]>;
}) {
  const [tab, setTab] = useState<ManageConnectorsTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const activeConnectors = connectors.filter(
    (connector) => connector.status !== "disabled",
  );
  const disabledConnectors = connectors.filter(
    (connector) => connector.status === "disabled",
  );
  const visibleCatalog = connectorCatalog.filter((item) =>
    connectorCatalogMatches(item, searchQuery),
  );
  const visibleManagedConnectors = connectors.filter((connector) =>
    connectorMatchesSearch(connector, searchQuery),
  );
  const filterLabel = tab === "active" ? "Managed" : "All connectors";

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [initialTab, open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid h-[min(860px,calc(100svh-1rem))] w-[min(980px,calc(100vw-1rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <>
          <DialogHeader className="border-b px-4 py-3 pr-11 text-left sm:px-5 sm:py-4 sm:pr-12">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DialogTitle className="text-lg sm:text-xl">
                  Manage Connectors
                </DialogTitle>
                <Badge
                  className="h-5 shrink-0 px-1.5 text-[10px]"
                  variant="secondary"
                >
                  {activeConnectors.length} active
                </Badge>
                {disabledConnectors.length > 0 ? (
                  <Badge
                    className="h-5 shrink-0 px-1.5 text-[10px]"
                    variant="outline"
                  >
                    {disabledConnectors.length} disabled
                  </Badge>
                ) : null}
              </div>
              <DialogDescription className="mt-1 max-w-[680px] text-xs leading-5 sm:text-sm">
                Connect SourceWeft to knowledge, project, and communication
                tools.
              </DialogDescription>
            </div>
            <div className="mt-3 grid min-w-0 gap-2 md:grid-cols-[minmax(0,auto)_minmax(220px,320px)] md:items-center md:justify-between">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="h-9 w-full justify-between gap-2 rounded-lg px-3 text-xs md:w-48"
                    type="button"
                    variant="outline"
                  >
                    <span className="min-w-0 truncate text-left">
                      <span className="text-muted-foreground">Filter:</span>{" "}
                      {filterLabel}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem onSelect={() => setTab("all")}>
                    <CheckCircle2
                      className={cn("size-3.5", tab !== "all" && "opacity-0")}
                    />
                    All connectors
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setTab("active")}>
                    <CheckCircle2
                      className={cn(
                        "size-3.5",
                        tab !== "active" && "opacity-0",
                      )}
                    />
                    Managed
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-9 rounded-lg bg-muted/35 pr-8 pl-8 text-sm"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search connectors"
                  value={searchQuery}
                />
                {searchQuery ? (
                  <button
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearchQuery("")}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          </DialogHeader>

          <ScrollArea className="min-h-0">
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {loadingError ? (
                <Alert variant="destructive">
                  <AlertDescription>{loadingError}</AlertDescription>
                </Alert>
              ) : null}
              {isLoading ? (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading connectors...
                </div>
              ) : null}

              {tab === "all" ? (
                <div className="mt-0 space-y-4">
                  {connectorCatalogCategories.map((category) => {
                    const items = visibleCatalog.filter(
                      (item) => item.category === category,
                    );
                    if (items.length === 0) return null;
                    return (
                      <section className="space-y-2" key={category}>
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-xs font-medium text-muted-foreground">
                            {category}
                          </h3>
                          <span className="text-[10px] text-muted-foreground">
                            {items.length}
                          </span>
                        </div>
                        <div className="grid gap-2.5 lg:grid-cols-2">
                          {items.map((item) => {
                            const connector = getCatalogConnector(
                              item,
                              connectors,
                            );
                            const status = getCatalogStatus({
                              item,
                              connectors,
                              accounts,
                              connectorBusyById,
                              connectorWaitingByType,
                              connectorReadinessById,
                              webhookConfigsById,
                            });
                            return (
                              <ConnectorCatalogCard
                                connector={connector}
                                item={item}
                                key={item.id}
                                onCancelConnector={onCancelConnector}
                                onConfigure={() => {
                                  if (connector) {
                                    onOpenSettings(connector);
                                    return;
                                  }
                                  setTab("active");
                                }}
                                onConnectConnector={onConnectConnector}
                                onCreateConnector={onCreateConnector}
                                onDisconnect={onDisconnectConnector}
                                onRequestConnector={onRequestConnector}
                                status={status}
                              />
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                  {visibleCatalog.length === 0 ? (
                    <HubEmptyState
                      description="Try a different provider, capability, or category."
                      icon={Search}
                      title={`No connectors match "${searchQuery}"`}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="mt-0 space-y-3">
                  {visibleManagedConnectors.length > 0 ? (
                    visibleManagedConnectors.map((connector) => (
                      <ActiveConnectorCard
                        connector={connector}
                        connectorBusyById={connectorBusyById}
                        connectorReadinessById={connectorReadinessById}
                        key={connector.id}
                        onBackToCatalog={() => setTab("all")}
                        onCopyWebhook={onCopyWebhook}
                        onDisconnect={onDisconnectConnector}
                        onOpenSettings={onOpenSettings}
                        onSyncConnector={onSyncConnector}
                        onToggleStatus={onToggleConnectorStatus}
                        webhookConfig={webhookConfigsById[connector.id] ?? null}
                        webhookEvents={
                          webhookEventsByConnectorId[connector.id] ?? []
                        }
                      />
                    ))
                  ) : (
                    <HubEmptyState
                      description={
                        searchQuery
                          ? "Try another connector name or status."
                          : "Connect Notion or choose an upcoming integration from the catalog."
                      }
                      icon={Link2}
                      title={
                        searchQuery
                          ? `No connectors match "${searchQuery}"`
                          : "No connectors yet."
                      }
                    />
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorsTab({
  connectors,
  connectorBusyById,
  connectorReadinessById,
  isLoading,
  loadingError,
  onConfigureConnector,
  onManageConnectors,
  onSyncConnector,
  onToggleConnectorStatus,
  webhookConfigsById,
}: {
  connectors: ConnectorItem[];
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  isLoading: boolean;
  loadingError: string | null;
  onConfigureConnector: (connector: ConnectorItem) => void;
  onManageConnectors: () => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleConnectorStatus: (connector: ConnectorItem) => void;
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
}) {
  const activeConnectors = connectors.filter(
    (connector) => connector.status !== "disabled",
  );
  const errorConnectors = activeConnectors.filter(
    (connector) => connector.status === "error" || connector.raw.lastError,
  );
  const needsWebhookSetup = activeConnectors.some((connector) => {
    const catalogItem = connectorCatalog.find(
      (item) => item.id === connector.raw.connectorType,
    );
    const webhookConfig = webhookConfigsById[connector.id] ?? null;
    return Boolean(
      catalogItem?.supportsWebhook &&
        webhookConfig &&
        !webhookConfig.isConfigured,
    );
  });

  return (
    <section className="space-y-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-foreground">Connectors</h3>
          <span className="text-[10px] text-muted-foreground">
            {activeConnectors.length} active
          </span>
        </div>
        <Button
          disabled={isLoading}
          onClick={onManageConnectors}
          size="xs"
          type="button"
          variant="outline"
        >
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Settings2 className="size-3.5" />
          )}
          Manage
        </Button>
      </div>

      {loadingError ? (
        <Alert className="mb-2" variant="destructive">
          <AlertDescription>{loadingError}</AlertDescription>
        </Alert>
      ) : null}

      {activeConnectors.length > 0 ? (
        <div className="space-y-1.5">
          {activeConnectors.map((connector) => {
            const isBusy = Boolean(connectorBusyById[connector.id]);
            const readiness = connectorReadinessById[connector.id] ?? null;
            const providerName = getConnectorDisplayName(connector);
            const catalogItem = connectorCatalog.find(
              (item) => item.id === connector.raw.connectorType,
            );
            const subtitle =
              formatConnectorReadinessSummary(readiness) ??
              compactConnectorProviderMeta(connector);
            return (
              <div
                className="rounded-lg border bg-background p-2 text-xs"
                key={connector.id}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ConnectorLogo
                    active={connector.status === "active"}
                    className="size-8"
                    icon={catalogItem?.icon ?? Link2}
                    label={providerName}
                    logoIconName={catalogItem?.logoIconName}
                    logoIconTone={catalogItem?.logoIconTone}
                    logoSrc={catalogItem?.logoSrc}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <button
                        className="min-w-0 truncate text-left font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        onClick={() => onConfigureConnector(connector)}
                        title={`Open ${providerName} settings`}
                        type="button"
                      >
                        {providerName}
                      </button>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {connector.status}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {subtitle}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      className={cn("size-7", disabledConnectorIconButtonClass)}
                      disabled={connector.status === "disabled" || isBusy}
                      onClick={() => onSyncConnector(connector)}
                      size="icon-xs"
                      title={
                        connector.status === "paused"
                          ? `Sync paused ${providerName} manually`
                          : connector.status === "disabled"
                            ? `${providerName} is disabled`
                            : `Sync ${providerName}`
                      }
                      type="button"
                      variant="ghost"
                    >
                      {isBusy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      <span className="sr-only">Sync {providerName}</span>
                    </Button>
                    <Button
                      className="size-7"
                      onClick={() => onConfigureConnector(connector)}
                      size="icon-xs"
                      title={`Open ${providerName} settings`}
                      type="button"
                      variant="ghost"
                    >
                      <Settings2 className="size-3.5" />
                      <span className="sr-only">Configure {providerName}</span>
                    </Button>
                    <Button
                      className={cn("size-7", disabledConnectorIconButtonClass)}
                      disabled={isBusy}
                      onClick={() => onToggleConnectorStatus(connector)}
                      size="icon-xs"
                      title={
                        connector.status === "paused"
                          ? `Resume ${providerName}`
                          : `Pause ${providerName}`
                      }
                      type="button"
                      variant="ghost"
                    >
                      {connector.status === "paused" ? (
                        <Play className="size-3.5" />
                      ) : (
                        <PowerOff className="size-3.5" />
                      )}
                      <span className="sr-only">
                        {connector.status === "paused" ? "Resume" : "Pause"}{" "}
                        {providerName}
                      </span>
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <HubEmptyState
          description="Open the catalog to connect Notion or preview upcoming integrations."
          icon={Link2}
          title="No active connectors yet."
        />
      )}
    </section>
  );
}

function CitationsTab({
  activeCitationChunkId,
  activeCitationIndex,
  activeCitationItems,
  citationScope,
  currentCitationItems,
  currentCitationMessageId,
  filteredCitationItems,
  mode,
  onCitationLocate,
  onCitationOpen,
  onScopeChange,
  searchQuery,
  threadCitationItems,
}: {
  activeCitationChunkId: string | null;
  activeCitationIndex: number | null;
  activeCitationItems: DisplayCitationItem[];
  citationScope: CitationScope;
  currentCitationItems: DisplayCitationItem[];
  currentCitationMessageId: string | null;
  filteredCitationItems: DisplayCitationItem[];
  mode: "thread" | "new";
  onCitationLocate?: (messageId: string) => void;
  onCitationOpen?: (
    citation: CitationRecord,
    context?: CitationOpenContext,
  ) => void;
  onScopeChange: (scope: CitationScope) => void;
  searchQuery: string;
  threadCitationItems: DisplayCitationItem[];
}) {
  return (
    <section className="space-y-1">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-foreground">Citations</h3>
          <span className="text-[10px] text-muted-foreground">
            {citationScope === "thread"
              ? `${threadCitationItems.length} in thread`
              : `${currentCitationItems.length} current`}
          </span>
          {searchQuery ? (
            <span className="text-[10px] text-primary">
              {filteredCitationItems.length} found
            </span>
          ) : null}
        </div>
      </div>

      {mode === "thread" ? (
        <div className="mb-2 grid grid-cols-2 rounded-lg border bg-muted/30 p-1">
          {(
            [
              ["current", `Current (${currentCitationItems.length})`],
              ["thread", `Thread (${threadCitationItems.length})`],
            ] as const
          ).map(([scope, label]) => (
            <button
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                citationScope === scope
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={scope}
              onClick={() => onScopeChange(scope)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {filteredCitationItems.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground">
          {searchQuery
            ? `No citations match "${searchQuery}".`
            : citationScope === "thread"
              ? "No citations found in this thread."
              : "No citations used in the selected answer."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filteredCitationItems.map((citation) => {
            const citationRecord = citation.citationRecord;
            const displayIndex =
              activeCitationItems.findIndex((item) => item.id === citation.id) +
              1;
            const isActive =
              citationScope === "current"
                ? activeCitationIndex === displayIndex
                : activeCitationChunkId === citationRecord.chunkId;
            const locateMessageId =
              citation.messageId ??
              (citationScope === "current" ? currentCitationMessageId : null);
            const canLocate = Boolean(locateMessageId);

            return (
              <article
                className={cn(
                  "rounded-xl border bg-background p-3 shadow-xs transition-colors",
                  isActive && "border-primary/45 bg-primary/5 shadow-sm",
                  canLocate &&
                    "cursor-pointer hover:border-primary/30 hover:bg-primary/5",
                )}
                key={citation.id}
                onClick={() => {
                  if (locateMessageId) {
                    onCitationLocate?.(locateMessageId);
                  }
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                      {displayIndex}
                    </span>
                    <div className="min-w-0">
                      <h4 className="truncate text-sm font-medium text-foreground">
                        {citation.sourceTitle}
                      </h4>
                      <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        {citation.messageLabel}
                      </div>
                    </div>
                  </div>
                  <Button
                    onClick={(event) => {
                      event.stopPropagation();
                      onCitationOpen?.(citationRecord, {
                        messageId: locateMessageId ?? undefined,
                      });
                    }}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <FileText className="size-3.5" />
                    Open
                  </Button>
                </div>
                <div className="mt-2 line-clamp-4 rounded-lg border border-input bg-muted/20 px-2.5 py-2 text-sm leading-6 text-foreground/90">
                  {citation.excerpt}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function filterCitations(items: DisplayCitationItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items;
  }
  return items.filter(
    (citation) =>
      citation.sourceTitle.toLowerCase().includes(q) ||
      citation.messageLabel.toLowerCase().includes(q) ||
      citation.excerpt.toLowerCase().includes(q) ||
      citation.citationRecord.citation.toLowerCase().includes(q),
  );
}

function countFilteredSources(items: SourceItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items.length;
  }
  return items.filter((source) => sourceMatchesQuery(source, q)).length;
}

function countSelectedSourceCoverage(
  tree: SourceTreeNode[],
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);
  const countedIds = new Set<string>();
  let count = 0;

  function visit(node: SourceTreeNode, coveredByAncestor: boolean) {
    const selected = selectedSet.has(node.source.id);
    const covered = coveredByAncestor || selected;

    if (
      covered &&
      isSelectableSource(node.source) &&
      !countedIds.has(node.source.id)
    ) {
      countedIds.add(node.source.id);
      count += 1;
    }

    for (const child of node.children) {
      visit(child, covered);
    }
  }

  for (const node of tree) {
    visit(node, false);
  }
  return count;
}

function countFilteredSkills(items: HubSkillItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items.length;
  }
  return items.filter(
    (skill) =>
      skill.displayName.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q) ||
      skill.name.toLowerCase().includes(q) ||
      skill.slug.toLowerCase().includes(q) ||
      skillSourceLabel(skill.sourceType).toLowerCase().includes(q),
  ).length;
}

function buildHubSkillIconsById(
  skills: readonly HubSkillItem[],
  capabilityCatalog: ListCapabilityCatalogResponse | null | undefined,
) {
  const commands = capabilityCatalog?.commands ?? [];
  if (commands.length === 0) {
    return new Map<string, SkillIconSpec>();
  }

  const skillByTargetId = new Map<string, HubSkillItem>();
  for (const skill of skills) {
    skillByTargetId.set(skill.name.toLowerCase(), skill);
    skillByTargetId.set(skill.slug.toLowerCase(), skill);
  }

  const iconsById = new Map<string, SkillIconSpec>();
  for (const command of commands) {
    if (command.action.kind !== "skill" || !command.iconName) {
      continue;
    }

    const skill = skillByTargetId.get(command.action.targetId.toLowerCase());
    if (!skill || iconsById.has(skill.id)) {
      continue;
    }

    iconsById.set(skill.id, {
      iconName: command.iconName,
      ...(command.iconTone ? { iconTone: command.iconTone } : {}),
    });
  }

  return iconsById;
}

function mapConnectorToUi(connector: SourceConnector): ConnectorItem {
  const lastSync = connector.lastIndexedAt
    ? `Last sync ${new Date(connector.lastIndexedAt).toLocaleString()}`
    : "Never synced";
  const schedule = formatConnectorSchedule(connector);
  return {
    id: connector.id,
    name: connector.name,
    status: connector.status,
    meta: `${connector.connectorType} · ${lastSync} · ${schedule}`,
    raw: connector,
  };
}

export function SourcesHub({
  activeCitationIndex = null,
  citations = [],
  currentCitationMessageId = null,
  mode,
  onCitationOpen,
  onCitationLocate,
  selectedIds,
  onSelectionChange,
  threadCitations = [],
  threadId = null,
  artifactsRefreshKey = 0,
  workfilesRefreshKey = 0,
  workspaceId,
  workspaceName,
  initialSources = [],
  initialSourcesLoaded = false,
  onSourceLoad,
  onSourceMerge,
  onConnectorsChange,
  onArtifactOpen,
  onSkillsCatalogChange,
  installedSkills = [],
  hubSkills,
  capabilityCatalog,
  selectedSkillIds = [],
  onSkillSelectionChange = () => {},
  selectedMcpInstallIds = [],
  selectedMcpToolIds = [],
  onMcpSelectionChange = () => {},
  disabledToolNames = [],
  onClose,
  variant = "panel",
}: {
  activeCitationIndex?: number | null;
  citations?: CitationRecord[];
  currentCitationMessageId?: string | null;
  mode: "thread" | "new";
  onCitationOpen?: (
    citation: CitationRecord,
    context?: CitationOpenContext,
  ) => void;
  onCitationLocate?: (messageId: string) => void;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  threadCitations?: ThreadCitationRecord[];
  threadId?: string | null;
  artifactsRefreshKey?: number;
  workfilesRefreshKey?: number;
  workspaceId?: string | null;
  workspaceName?: string | null;
  initialSources?: SourceItem[];
  initialSourcesLoaded?: boolean;
  onSourceLoad?: (sources: SourceItem[]) => void;
  onSourceMerge?: (sources: SourceItem[]) => void;
  onConnectorsChange?: (connectors: SourceConnector[]) => void;
  onArtifactOpen?: (artifact: ArtifactListItem) => void;
  onSkillsCatalogChange?: () => void | Promise<void>;
  installedSkills?: HubSkillItem[];
  hubSkills?: HubSkillItem[];
  capabilityCatalog?: ListCapabilityCatalogResponse | null;
  selectedSkillIds?: string[];
  onSkillSelectionChange?: (ids: string[]) => void;
  selectedMcpInstallIds?: string[];
  selectedMcpToolIds?: string[];
  onMcpSelectionChange?: (selection: McpToolSelection) => void;
  disabledToolNames?: string[];
  onClose?: () => void;
  variant?: "panel" | "drawer";
}) {
  const [activeTab, setActiveTab] = useState<HubTab>(getLastHubActiveTab);
  const [citationScope, setCitationScope] = useState<CitationScope>("current");
  const [searchQueries, setSearchQueries] = useState<Record<HubTab, string>>({
    Sources: "",
    Workfiles: "",
    Artifacts: "",
    Skills: "",
    MCP: "",
    Citations: "",
    Connectors: "",
  });
  const searchQuery = searchQueries[activeTab];
  const deferredSearchQueries = useDeferredValue(searchQueries);
  const deferredSearchQuery = deferredSearchQueries[activeTab];
  const [sources, setSources] = useState<SourceItem[]>(initialSources);
  const skillsForHub = hubSkills ?? installedSkills;
  const [isLoading, setIsLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [workfiles, setWorkfiles] = useState<WorkfileListItem[]>([]);
  const [isLoadingWorkfiles, setIsLoadingWorkfiles] = useState(false);
  const [workfilesLoadingError, setWorkfilesLoadingError] = useState<
    string | null
  >(null);
  const [artifacts, setArtifacts] = useState<ArtifactListItem[]>([]);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [isLoadingMoreArtifacts, setIsLoadingMoreArtifacts] = useState(false);
  const [artifactsLoadingError, setArtifactsLoadingError] = useState<
    string | null
  >(null);
  const [artifactsNextCursor, setArtifactsNextCursor] = useState<string | null>(
    null,
  );
  const [mcpInstalls, setMcpInstalls] = useState<WorkspaceMcpInstall[]>([]);
  const [isLoadingMcp, setIsLoadingMcp] = useState(false);
  const [mcpLoadingError, setMcpLoadingError] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [connectorAccounts, setConnectorAccounts] = useState<
    ConnectorAccountItem[]
  >([]);
  const [isLoadingConnectors, setIsLoadingConnectors] = useState(false);
  const [connectorsLoadingError, setConnectorsLoadingError] = useState<
    string | null
  >(null);
  const [connectorBusyById, setConnectorBusyById] = useState<
    Record<string, boolean>
  >({});
  const [connectorWaitingByType, setConnectorWaitingByType] = useState<
    Record<string, boolean>
  >({});
  const [isManageConnectorsOpen, setIsManageConnectorsOpen] = useState(false);
  const [manageConnectorsInitialTab, setManageConnectorsInitialTab] =
    useState<ManageConnectorsTab>("all");
  const [connectorReadinessById, setConnectorReadinessById] = useState<
    Record<string, ConnectorReadinessState>
  >({});
  const [pendingDisconnectConnector, setPendingDisconnectConnector] =
    useState<ConnectorItem | null>(null);
  const [disconnectConnectorHardDelete, setDisconnectConnectorHardDelete] =
    useState(false);
  const [connectorWebhookEventsById, setConnectorWebhookEventsById] = useState<
    Record<string, ConnectorWebhookEventItem[]>
  >({});
  const [connectorWebhookConfigsById, setConnectorWebhookConfigsById] =
    useState<Record<string, ConnectorWebhookConfig | null>>({});
  const [connectorSettingsConnectorId, setConnectorSettingsConnectorId] =
    useState<string | null>(null);
  const [connectorSettingsActivity, setConnectorSettingsActivity] = useState<
    ConnectorActivityItem[]
  >([]);
  const [
    isLoadingConnectorSettingsActivity,
    setIsLoadingConnectorSettingsActivity,
  ] = useState(false);
  const [connectorSettingsActivityError, setConnectorSettingsActivityError] =
    useState<string | null>(null);
  const [previewWorkfile, setPreviewWorkfile] = useState<WorkfileDetail | null>(
    null,
  );
  const [deleteWorkfile, setDeleteWorkfile] = useState<WorkfileListItem | null>(
    null,
  );
  const [workfileBusyByPath, setWorkfileBusyByPath] = useState<
    Record<string, boolean>
  >({});
  const currentCitationItems = useMemo(
    () => mapCitationsToUi(citations),
    [citations],
  );
  const threadCitationItems = useMemo(
    () => mapThreadCitationsToUi(threadCitations),
    [threadCitations],
  );
  const activeCitationItems =
    citationScope === "thread" ? threadCitationItems : currentCitationItems;
  const filteredCitationItems = useMemo(
    () => filterCitations(activeCitationItems, deferredSearchQueries.Citations),
    [activeCitationItems, deferredSearchQueries.Citations],
  );
  const filteredSourceCount = useMemo(
    () => countFilteredSources(sources, deferredSearchQueries.Sources),
    [deferredSearchQueries.Sources, sources],
  );
  const filteredSkillCount = useMemo(
    () => countFilteredSkills(skillsForHub, deferredSearchQueries.Skills),
    [deferredSearchQueries.Skills, skillsForHub],
  );
  const skillIconsById = useMemo(
    () => buildHubSkillIconsById(skillsForHub, capabilityCatalog),
    [capabilityCatalog, skillsForHub],
  );
  const filteredWorkfileCount = useMemo(() => {
    const q = deferredSearchQueries.Workfiles.trim().toLowerCase();
    return q
      ? workfiles.filter((file) => workfileMatchesQuery(file, q)).length
      : workfiles.length;
  }, [deferredSearchQueries.Workfiles, workfiles]);
  const filteredArtifactCount = useMemo(() => {
    const q = deferredSearchQueries.Artifacts.trim().toLowerCase();
    return q
      ? artifacts.filter((artifact) => artifactMatchesQuery(artifact, q)).length
      : artifacts.length;
  }, [artifacts, deferredSearchQueries.Artifacts]);
  const connectorSettingsConnector = useMemo(() => {
    if (!connectorSettingsConnectorId) return null;
    return (
      connectors.find(
        (connector) => connector.id === connectorSettingsConnectorId,
      ) ?? null
    );
  }, [connectorSettingsConnectorId, connectors]);
  const activeCitationChunkId = activeCitationIndex
    ? (citations[activeCitationIndex - 1]?.chunkId ?? null)
    : null;
  const addSourceDialog = useAddSourceDialogState();
  const resetAddSourceDialog = addSourceDialog.reset;
  const [isCreateDirectoryOpen, setIsCreateDirectoryOpen] = useState(false);
  const [directoryTitle, setDirectoryTitle] = useState("");
  const [directoryContext, setDirectoryContext] = useState("");
  const [directoryParentSourceId, setDirectoryParentSourceId] = useState<
    string | null
  >(null);
  const [readmeSource, setReadmeSource] = useState<SourceItem | null>(null);
  const [readmeContent, setReadmeContent] = useState("");
  const [moveSource, setMoveSource] = useState<SourceItem | null>(null);
  const [moveParentSourceId, setMoveParentSourceId] = useState<string | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const currentWorkspaceIdRef = useRef<string | null | undefined>(workspaceId);
  const loadedSourcesWorkspaceIdRef = useRef<string | null>(null);
  const initializedSourcesWorkspaceIdRef = useRef<string | null>(null);
  const sourcesRef = useRef<SourceItem[]>(initialSources);
  const selectedIdsRef = useRef<string[]>(selectedIds);
  const pendingAutoSelectSourceIdsRef = useRef<Set<string>>(new Set());
  const manualConnectorSyncSourcesRef = useRef<
    Map<string, { knownSourceIds: Set<string> }>
  >(new Map());
  const activeSyncRunsRef = useRef<Map<string, ActiveConnectorSyncRun>>(
    new Map(),
  );
  const syncRunPollTimerRef = useRef<number | null>(null);
  const syncRunLeaderTimerRef = useRef<number | null>(null);
  const syncRunHeartbeatTimerRef = useRef<number | null>(null);
  const syncRunPollInFlightRef = useRef(false);
  const syncRunPollErrorCountRef = useRef(0);
  const syncRunNeedsCooldownConfirmationRef = useRef(false);
  const syncRunPollStoppedRef = useRef(false);
  const syncRunLeaderCandidatesRef = useRef<
    Map<string, ConnectorSyncRunLeaderCandidate>
  >(new Map());
  const syncRunIsLeaderRef = useRef(false);
  const syncRunChannelRef = useRef<BroadcastChannel | null>(null);
  const requestSyncRunPollRef = useRef<((delayMs?: number) => void) | null>(
    null,
  );
  const sourcesHubTabIdRef = useRef<string | null>(null);
  if (sourcesHubTabIdRef.current === null) {
    sourcesHubTabIdRef.current = createSourcesHubTabId();
  }

  const [pendingSourceIds, setPendingSourceIds] = useState<string[]>([]);

  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [rowBusyById, setRowBusyById] = useState<Record<string, boolean>>({});
  const [previewSource, setPreviewSource] = useState<SourceItem | null>(null);
  const [previewSkillCatalogId, setPreviewSkillCatalogId] = useState<
    string | null
  >(null);
  const [isSkillsGalleryOpen, setIsSkillsGalleryOpen] = useState(false);
  const [deleteSource, setDeleteSource] = useState<SourceItem | null>(null);
  const [deleteSelectedSourcesOpen, setDeleteSelectedSourcesOpen] =
    useState(false);
  const [isDeletingSelectedSources, setIsDeletingSelectedSources] =
    useState(false);
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(
    () => readStoredSourceTreeExpansion(workspaceId).expandedDirectoryIds,
  );
  const [userCollapsedDirectoryIds, setUserCollapsedDirectoryIds] = useState<
    Set<string>
  >(() => readStoredSourceTreeExpansion(workspaceId).userCollapsedDirectoryIds);
  const expandedDirectoryIdsRef = useRef<Set<string>>(expandedDirectoryIds);
  const userCollapsedDirectoryIdsRef = useRef<Set<string>>(
    userCollapsedDirectoryIds,
  );
  const expansionWorkspaceIdRef = useRef<string | null | undefined>(
    workspaceId,
  );
  const sourceTreeIndex = useMemo(
    () => buildSourceTreeIndex(sources),
    [sources],
  );
  const fullSourceTree = useMemo(
    () => buildSourceTreeFromIndex(sourceTreeIndex, ""),
    [sourceTreeIndex],
  );
  const processedConnectorOAuthMessageIdsRef = useRef<Set<string>>(new Set());
  const ensureConnectorPromisesRef = useRef<
    Map<string, Promise<ConnectorItem | null>>
  >(new Map());
  const connectorWaitingStartedAtRef = useRef<Record<string, number>>({});
  const selectableSourceIds = useMemo(
    () => collectSelectableSourceIds(fullSourceTree),
    [fullSourceTree],
  );
  const selectedLibrarySources = useMemo(
    () => expandSelectedSources(sources, selectedIds),
    [selectedIds, sources],
  );
  const selectedSourceCoverageCount = useMemo(
    () => countSelectedSourceCoverage(fullSourceTree, selectedIds),
    [fullSourceTree, selectedIds],
  );
  const selectedSourceIdsForBulkDelete = useMemo(() => {
    const selectedSet = new Set(
      selectedLibrarySources.map((source) => source.id),
    );
    const coveredByAncestor = new Set<string>();
    const visit = (node: SourceTreeNode, ancestorSelected: boolean) => {
      const isSelected = selectedSet.has(node.source.id);
      if (ancestorSelected && isSelected) {
        coveredByAncestor.add(node.source.id);
      }
      for (const child of node.children) {
        visit(child, ancestorSelected || isSelected);
      }
    };
    for (const node of fullSourceTree) {
      visit(node, false);
    }
    return selectedLibrarySources
      .map((source) => source.id)
      .filter((id) => !coveredByAncestor.has(id));
  }, [fullSourceTree, selectedLibrarySources]);
  const allSelectableSourcesSelected =
    selectableSourceIds.length > 0 &&
    selectedLibrarySources.length >= selectableSourceIds.length;
  function setActiveSearchQuery(value: string) {
    setSearchQueries((current) => ({
      ...current,
      [activeTab]: value,
    }));
  }

  async function handleWorkspaceSkillEnabledChange(
    skill: HubSkillItem,
    enabled: boolean,
  ) {
    if (!workspaceId || !skill.workspaceSkillId) {
      return;
    }

    try {
      await contentClient.updateWorkspaceSkill(workspaceId, skill.workspaceSkillId, {
        enabled,
      });
      if (!enabled && selectedSkillIds.includes(skill.id)) {
        onSkillSelectionChange(selectedSkillIds.filter((id) => id !== skill.id));
      }
      await onSkillsCatalogChange?.();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          enabled ? "Failed to enable skill." : "Failed to disable skill.",
        ),
      );
    }
  }

  selectedIdsRef.current = selectedIds;

  const commitSources = useCallback((nextSources: SourceItem[]) => {
    sourcesRef.current = nextSources;
    setSources(nextSources);
  }, []);

  const selectNewSourceIds = useCallback(
    (sourceIds: string[], sourceTree: SourceTreeNode[] = fullSourceTree) => {
      for (const sourceId of sourceIds) {
        pendingAutoSelectSourceIdsRef.current.add(sourceId);
      }

      const currentSelectedIds = selectedIdsRef.current;
      const nextSelectedIds = mergeSourceSelectionFromTree(
        sourceTree,
        currentSelectedIds,
        sourceIds,
      );
      if (!areStringArraysEqual(nextSelectedIds, currentSelectedIds)) {
        selectedIdsRef.current = nextSelectedIds;
        onSelectionChange(nextSelectedIds);
      }

      for (const sourceId of nextSelectedIds) {
        pendingAutoSelectSourceIdsRef.current.delete(sourceId);
      }
    },
    [fullSourceTree, onSelectionChange],
  );

  const selectPendingAutoSources = useCallback(
    (nextSources: SourceItem[]) => {
      if (pendingAutoSelectSourceIdsRef.current.size === 0) {
        return;
      }

      const availableSourceIds = new Set(
        nextSources.map((source) => source.id),
      );
      const sourceIdsToAdd = Array.from(
        pendingAutoSelectSourceIdsRef.current,
      ).filter((sourceId) => availableSourceIds.has(sourceId));
      if (sourceIdsToAdd.length === 0) {
        return;
      }

      const currentSelectedIds = selectedIdsRef.current;
      const sourceTree = buildSourceTree(nextSources, "");
      const nextSelectedIds = mergeSourceSelectionFromTree(
        sourceTree,
        currentSelectedIds,
        sourceIdsToAdd,
      );

      if (!areStringArraysEqual(nextSelectedIds, currentSelectedIds)) {
        selectedIdsRef.current = nextSelectedIds;
        onSelectionChange(nextSelectedIds);
      }

      const selectedSourceIds = new Set(
        expandSelectedSources(nextSources, nextSelectedIds).map(
          (source) => source.id,
        ),
      );
      for (const sourceId of sourceIdsToAdd) {
        if (selectedSourceIds.has(sourceId)) {
          pendingAutoSelectSourceIdsRef.current.delete(sourceId);
        }
      }
    },
    [onSelectionChange],
  );

  const trackManualConnectorSync = useCallback(
    (connectorId: string) => {
      manualConnectorSyncSourcesRef.current.set(connectorId, {
        knownSourceIds: new Set(
          sources
            .filter((source) => source.connectorId === connectorId)
            .map((source) => source.id),
        ),
      });
    },
    [sources],
  );

  const selectNewManualConnectorSources = useCallback(
    (nextSources: SourceItem[]) => {
      if (manualConnectorSyncSourcesRef.current.size === 0) {
        return;
      }

      const sourceTree = buildSourceTree(nextSources, "");
      const currentSelectedIds = selectedIdsRef.current;
      let nextSelectedIds = currentSelectedIds;
      let changed = false;

      for (const [
        connectorId,
        tracked,
      ] of manualConnectorSyncSourcesRef.current) {
        const connectorSources = nextSources.filter(
          (source) => source.connectorId === connectorId,
        );
        const newSourceIds = connectorSources
          .filter((source) => !tracked.knownSourceIds.has(source.id))
          .map((source) => source.id);

        if (newSourceIds.length > 0) {
          for (const sourceId of newSourceIds) {
            pendingAutoSelectSourceIdsRef.current.add(sourceId);
          }
          nextSelectedIds = mergeSourceSelectionFromTree(
            sourceTree,
            nextSelectedIds,
            newSourceIds,
          );
          changed = true;
        }

        for (const source of connectorSources) {
          tracked.knownSourceIds.add(source.id);
        }
      }

      if (
        changed &&
        !areStringArraysEqual(nextSelectedIds, currentSelectedIds)
      ) {
        selectedIdsRef.current = nextSelectedIds;
        onSelectionChange(nextSelectedIds);
      }

      const selectedSourceIds = new Set(
        expandSelectedSources(nextSources, nextSelectedIds).map(
          (source) => source.id,
        ),
      );
      for (const sourceId of Array.from(
        pendingAutoSelectSourceIdsRef.current,
      )) {
        if (selectedSourceIds.has(sourceId)) {
          pendingAutoSelectSourceIdsRef.current.delete(sourceId);
        }
      }
    },
    [onSelectionChange],
  );

  const trackConnectorSyncRun = useCallback(
    (
      run:
        | {
            id: string;
            connectorId: string;
            discoveredCount: number;
            indexedCount: number;
            failedCount: number;
          }
        | null
        | undefined,
    ) => {
      if (!run) {
        return;
      }
      activeSyncRunsRef.current.set(run.id, {
        connectorId: run.connectorId,
        discoveredCount: run.discoveredCount,
        indexedCount: run.indexedCount,
        failedCount: run.failedCount,
        lastSourceUpdatedAt: null,
        hasFinalRefreshed: false,
      });
      syncRunNeedsCooldownConfirmationRef.current = false;
      syncRunPollErrorCountRef.current = 0;
      requestSyncRunPollRef.current?.(0);
      const tabId = sourcesHubTabIdRef.current ?? createSourcesHubTabId();
      sourcesHubTabIdRef.current = tabId;
      syncRunChannelRef.current?.postMessage({
        type: "sync-runs-wake",
        tabId,
        sentAt: Date.now(),
      } satisfies ConnectorSyncRunBroadcastMessage);
    },
    [],
  );

  function handleActiveTabChange(tab: HubTab) {
    setActiveTab(tab);
    persistHubTab(tab);
  }

  useEffect(() => {
    const storedTab = readStoredHubTab();
    if (storedTab) {
      setActiveTab(storedTab);
    }
  }, []);

  useEffect(() => {
    setCitationScope("current");
  }, [mode]);

  useEffect(() => {
    currentWorkspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  useEffect(() => {
    expandedDirectoryIdsRef.current = expandedDirectoryIds;
    userCollapsedDirectoryIdsRef.current = userCollapsedDirectoryIds;
    if (expansionWorkspaceIdRef.current !== workspaceId) {
      return;
    }
    persistSourceTreeExpansion({
      workspaceId,
      expandedDirectoryIds,
      userCollapsedDirectoryIds,
    });
  }, [expandedDirectoryIds, userCollapsedDirectoryIds, workspaceId]);

  const autoExpandConnectorManagedDirectories = useCallback(
    (items: SourceItem[]) => {
      const directoryIds = items
        .filter(
          (source) =>
            source.sourceType === "directory" &&
            source.metadata?.connectorManagedDirectory === true,
        )
        .map((source) => source.id);
      if (directoryIds.length === 0) {
        return;
      }
      setExpandedDirectoryIds((current) => {
        let changed = false;
        const next = new Set(current);
        const collapsed = userCollapsedDirectoryIdsRef.current;
        for (const id of directoryIds) {
          if (!next.has(id) && !collapsed.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        if (changed) {
          expandedDirectoryIdsRef.current = next;
        }
        return changed ? next : current;
      });
    },
    [],
  );

  const refreshSources = useCallback(async () => {
    if (!workspaceId) {
      commitSources([]);
      onSourceLoad?.([]);
      loadedSourcesWorkspaceIdRef.current = null;
      return;
    }

    const activeWorkspaceId = workspaceId;
    const isInitialLoad =
      loadedSourcesWorkspaceIdRef.current !== activeWorkspaceId ||
      sourcesRef.current.length === 0;
    setIsLoading(true);
    setLoadingError(null);
    if (isInitialLoad) {
      commitSources([]);
    }
    try {
      const result = await contentClient.listSources(activeWorkspaceId, {
        view: "tree",
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      const mapped = mapSourcesToUi(result.items);
      commitSources(mapped);
      autoExpandConnectorManagedDirectories(mapped);
      loadedSourcesWorkspaceIdRef.current = activeWorkspaceId;
      onSourceLoad?.(mapped);
      onSourceMerge?.(mapped);
      selectPendingAutoSources(mapped);
      selectNewManualConnectorSources(mapped);

      const syncing = result.items
        .filter(
          (item) => item.status === "queued" || item.status === "processing",
        )
        .map((item) => item.id);
      if (syncing.length > 0) {
        setPendingSourceIds((prev) =>
          Array.from(new Set([...prev, ...syncing])),
        );
      }
    } catch (error) {
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      const message = getErrorMessage(error, "Failed to load sources.");
      setLoadingError(message);
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoading(false);
      }
    }
  }, [
    autoExpandConnectorManagedDirectories,
    commitSources,
    onSourceLoad,
    onSourceMerge,
    selectPendingAutoSources,
    selectNewManualConnectorSources,
    workspaceId,
  ]);

  const handleDirectoryExpandedChange = useCallback(
    (sourceId: string, open: boolean) => {
      const nextExpanded = new Set(expandedDirectoryIdsRef.current);
      const nextCollapsed = new Set(userCollapsedDirectoryIdsRef.current);
      if (open) {
        nextExpanded.add(sourceId);
        nextCollapsed.delete(sourceId);
      } else {
        nextExpanded.delete(sourceId);
        nextCollapsed.add(sourceId);
      }

      expandedDirectoryIdsRef.current = nextExpanded;
      userCollapsedDirectoryIdsRef.current = nextCollapsed;
      setExpandedDirectoryIds(nextExpanded);
      setUserCollapsedDirectoryIds(nextCollapsed);
      persistSourceTreeExpansion({
        workspaceId,
        expandedDirectoryIds: nextExpanded,
        userCollapsedDirectoryIds: nextCollapsed,
      });
    },
    [workspaceId],
  );

  const mergeIncrementalSources = useCallback(
    (mapped: SourceItem[]) => {
      if (mapped.length === 0) {
        return;
      }
      autoExpandConnectorManagedDirectories(mapped);
      const merged = upsertSources(sourcesRef.current, mapped);
      commitSources(merged);
      selectPendingAutoSources(merged);
      selectNewManualConnectorSources(merged);
      onSourceLoad?.(merged);
      onSourceMerge?.(mapped);
    },
    [
      autoExpandConnectorManagedDirectories,
      commitSources,
      onSourceLoad,
      onSourceMerge,
      selectNewManualConnectorSources,
      selectPendingAutoSources,
    ],
  );

  const replaceConnectorSources = useCallback(
    (batches: Array<{ connectorId: string; items: SourceItem[] }>) => {
      if (batches.length === 0) {
        return;
      }
      const connectorIds = new Set(batches.map((batch) => batch.connectorId));
      const mapped = batches.flatMap((batch) => batch.items);
      autoExpandConnectorManagedDirectories(mapped);
      const retained = sourcesRef.current.filter(
        (source) =>
          !source.connectorId || !connectorIds.has(source.connectorId),
      );
      const merged = upsertSources(retained, mapped);
      commitSources(merged);
      selectPendingAutoSources(merged);
      selectNewManualConnectorSources(merged);
      onSourceLoad?.(merged);
      if (mapped.length > 0) {
        onSourceMerge?.(mapped);
      }
    },
    [
      autoExpandConnectorManagedDirectories,
      commitSources,
      onSourceLoad,
      onSourceMerge,
      selectNewManualConnectorSources,
      selectPendingAutoSources,
    ],
  );

  const refreshWorkfiles = useCallback(async () => {
    if (!workspaceId || !threadId || mode !== "thread") {
      setWorkfiles([]);
      setWorkfilesLoadingError(null);
      return;
    }

    setIsLoadingWorkfiles(true);
    setWorkfilesLoadingError(null);
    try {
      const result = await contentClient.listWorkingFiles(
        workspaceId,
        threadId,
      );
      setWorkfiles(result.items);
      threadWorkfilesCache.set(
        getThreadWorkfilesCacheKey(workspaceId, threadId),
        cloneWorkfileItems(result.items),
      );
    } catch (error) {
      setWorkfilesLoadingError(
        getErrorMessage(error, "Failed to load workfiles."),
      );
    } finally {
      setIsLoadingWorkfiles(false);
    }
  }, [mode, threadId, workspaceId]);

  const refreshArtifacts = useCallback(async () => {
    if (!workspaceId) {
      setArtifacts([]);
      setArtifactsLoadingError(null);
      setArtifactsNextCursor(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingArtifacts(true);
    setArtifactsLoadingError(null);
    try {
      const result = await contentClient.listArtifacts(activeWorkspaceId, {
        limit: 100,
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      setArtifacts(result.items);
      setArtifactsNextCursor(result.nextCursor ?? null);
      workspaceArtifactsCache.set(
        activeWorkspaceId,
        cloneArtifactItems(result.items),
      );
      workspaceArtifactsCursorCache.set(
        activeWorkspaceId,
        result.nextCursor ?? null,
      );
      setCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
        WORKSPACE_ARTIFACTS_CACHE_BUCKET,
        activeWorkspaceId,
        {
          items: result.items,
          nextCursor: result.nextCursor ?? null,
        },
      );
    } catch (error) {
      setArtifactsLoadingError(
        getErrorMessage(error, "Failed to load artifacts."),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingArtifacts(false);
      }
    }
  }, [workspaceId]);

  const loadMoreArtifacts = useCallback(async () => {
    if (!workspaceId || !artifactsNextCursor || isLoadingMoreArtifacts) {
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingMoreArtifacts(true);
    setArtifactsLoadingError(null);
    try {
      const result = await contentClient.listArtifacts(activeWorkspaceId, {
        cursor: artifactsNextCursor,
        limit: 100,
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      setArtifacts((current) => {
        const mergedById = new Map(
          current.map((artifact) => [artifact.id, artifact]),
        );
        for (const artifact of result.items) {
          mergedById.set(artifact.id, artifact);
        }
        const merged = Array.from(mergedById.values());
        workspaceArtifactsCache.set(
          activeWorkspaceId,
          cloneArtifactItems(merged),
        );
        setCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
          WORKSPACE_ARTIFACTS_CACHE_BUCKET,
          activeWorkspaceId,
          {
            items: merged,
            nextCursor: result.nextCursor ?? null,
          },
        );
        return merged;
      });
      setArtifactsNextCursor(result.nextCursor ?? null);
      workspaceArtifactsCursorCache.set(
        activeWorkspaceId,
        result.nextCursor ?? null,
      );
    } catch (error) {
      setArtifactsLoadingError(
        getErrorMessage(error, "Failed to load more artifacts."),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingMoreArtifacts(false);
      }
    }
  }, [artifactsNextCursor, isLoadingMoreArtifacts, workspaceId]);

  const refreshConnectors = useCallback(async () => {
    if (!workspaceId) {
      setConnectors([]);
      setConnectorAccounts([]);
      setConnectorWebhookEventsById({});
      setConnectorWebhookConfigsById({});
      setConnectorsLoadingError(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingConnectors(true);
    setConnectorsLoadingError(null);
    try {
      const [result, accounts] = await Promise.all([
        connectorsClient.list(activeWorkspaceId, { includeDisabled: true }),
        connectorsClient.listAccounts(activeWorkspaceId),
      ]);
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }
      const uiConnectors = result.items.map(mapConnectorToUi);
      onConnectorsChange?.(result.items);
      setConnectorReadinessById((prev) => {
        const liveIds = new Set(uiConnectors.map((connector) => connector.id));
        let changed = false;
        const next: Record<string, ConnectorReadinessState> = {};
        for (const [id, state] of Object.entries(prev)) {
          if (liveIds.has(id)) {
            next[id] = state;
          } else {
            changed = true;
          }
        }
        for (const connector of uiConnectors) {
          const readiness = getConnectorReadinessFromConfig(connector.raw);
          if (readiness) {
            next[connector.id] = readiness;
            if (prev[connector.id]?.reason !== readiness.reason) {
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
      setConnectors(uiConnectors);
      setConnectorAccounts(accounts.items);
      const webhookConnectors = uiConnectors.filter((connector) => {
        const catalogItem = connectorCatalog.find(
          (item) => item.id === connector.raw.connectorType,
        );
        return connector.status !== "disabled" && catalogItem?.supportsWebhook;
      });
      const webhookResults = await Promise.allSettled(
        webhookConnectors.map(async (connector) => {
          const [webhookConfig, webhookEvents] = await Promise.allSettled([
            connectorsClient.getWebhookConfig(activeWorkspaceId, connector.id),
            connectorsClient.listWebhookEvents(activeWorkspaceId, {
              connectorType: connector.raw.connectorType,
              connectorId: connector.id,
            }),
          ]);
          return {
            connectorId: connector.id,
            webhookConfig:
              webhookConfig.status === "fulfilled" ? webhookConfig.value : null,
            webhookEvents:
              webhookEvents.status === "fulfilled"
                ? webhookEvents.value.items
                : [],
          };
        }),
      );
      const nextWebhookConfigs: Record<string, ConnectorWebhookConfig | null> =
        {};
      const nextWebhookEvents: Record<string, ConnectorWebhookEventItem[]> = {};
      for (const result of webhookResults) {
        if (result.status !== "fulfilled") {
          continue;
        }
        nextWebhookConfigs[result.value.connectorId] =
          result.value.webhookConfig;
        nextWebhookEvents[result.value.connectorId] =
          result.value.webhookEvents;
      }
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }
      setConnectorWebhookConfigsById(nextWebhookConfigs);
      setConnectorWebhookEventsById(nextWebhookEvents);
      setCachedWorkspaceHubValue<WorkspaceConnectorsCacheValue>(
        WORKSPACE_CONNECTORS_CACHE_BUCKET,
        activeWorkspaceId,
        {
          accounts: accounts.items,
          connectors: uiConnectors,
          webhookConfigsById: nextWebhookConfigs,
          webhookEventsById: nextWebhookEvents,
        },
      );
    } catch (error) {
      setConnectorsLoadingError(
        getErrorMessage(error, "Failed to load connectors."),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingConnectors(false);
      }
    }
  }, [onConnectorsChange, workspaceId]);

  const refreshMcpInstalls = useCallback(async () => {
    if (!workspaceId) {
      setMcpInstalls([]);
      setMcpLoadingError(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingMcp(true);
    setMcpLoadingError(null);
    try {
      const result =
        await contentClient.listWorkspaceMcpInstalls(activeWorkspaceId);
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }
      setMcpInstalls(result.items);
      setCachedWorkspaceHubValue<WorkspaceMcpCacheValue>(
        WORKSPACE_MCP_CACHE_BUCKET,
        activeWorkspaceId,
        { installs: result.items },
      );
      const installIds = new Set(result.items.map((install) => install.id));
      const toolIds = new Set(
        result.items.flatMap((install) => install.tools.map((tool) => tool.id)),
      );
      const nextInstallIds = selectedMcpInstallIds.filter((id) =>
        installIds.has(id),
      );
      const nextToolIds = selectedMcpToolIds.filter((id) => toolIds.has(id));
      if (
        nextInstallIds.length !== selectedMcpInstallIds.length ||
        nextToolIds.length !== selectedMcpToolIds.length
      ) {
        onMcpSelectionChange({
          enabled: nextInstallIds.length > 0 || nextToolIds.length > 0,
          installIds: nextInstallIds,
          toolIds: nextToolIds,
        });
      }
    } catch (error) {
      setMcpLoadingError(getErrorMessage(error, "Failed to load MCP tools."));
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingMcp(false);
      }
    }
  }, [
    onMcpSelectionChange,
    selectedMcpInstallIds,
    selectedMcpToolIds,
    workspaceId,
  ]);

  const refreshConnectorSettingsActivity = useCallback(
    async (connectorId?: string | null, options: { silent?: boolean } = {}) => {
      if (!workspaceId || !connectorId) {
        setConnectorSettingsActivity([]);
        setConnectorSettingsActivityError(null);
        setIsLoadingConnectorSettingsActivity(false);
        return;
      }

      if (!options.silent) {
        setIsLoadingConnectorSettingsActivity(true);
      }
      setConnectorSettingsActivityError(null);
      try {
        const result = await connectorsClient.listActivity(
          workspaceId,
          connectorId,
          { kind: "all", limit: 50 },
        );
        setConnectorSettingsActivity(result.items);
      } catch (error) {
        setConnectorSettingsActivity([]);
        setConnectorSettingsActivityError(
          getErrorMessage(error, "Failed to load connector activity."),
        );
      } finally {
        if (!options.silent) {
          setIsLoadingConnectorSettingsActivity(false);
        }
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    const sourceHydration = resolveWorkspaceSourceHydration({
      initializedWorkspaceId: initializedSourcesWorkspaceIdRef.current,
      initialSources,
      initialSourcesLoaded,
      workspaceId,
    });

    if (sourceHydration.kind === "clear") {
      loadedSourcesWorkspaceIdRef.current = null;
      initializedSourcesWorkspaceIdRef.current =
        sourceHydration.initializedWorkspaceId;
      expansionWorkspaceIdRef.current = workspaceId;
      expandedDirectoryIdsRef.current = new Set();
      userCollapsedDirectoryIdsRef.current = new Set();
      setExpandedDirectoryIds(new Set());
      setUserCollapsedDirectoryIds(new Set());
      commitSources(sourceHydration.sources);
      setLoadingError(null);
      setIsLoading(false);
      setPendingSourceIds([]);
      return;
    }

    if (sourceHydration.kind === "skip") {
      return;
    }
    initializedSourcesWorkspaceIdRef.current =
      sourceHydration.initializedWorkspaceId;
    const storedExpansion = readStoredSourceTreeExpansion(workspaceId);
    expansionWorkspaceIdRef.current = workspaceId;
    expandedDirectoryIdsRef.current = storedExpansion.expandedDirectoryIds;
    userCollapsedDirectoryIdsRef.current =
      storedExpansion.userCollapsedDirectoryIds;
    setExpandedDirectoryIds(storedExpansion.expandedDirectoryIds);
    setUserCollapsedDirectoryIds(storedExpansion.userCollapsedDirectoryIds);

    setLoadingError(null);
    setPendingSourceIds([]);
    setEditingSourceId(null);
    setEditingTitle("");
    setRowBusyById({});
    setPreviewSource(null);
    setDeleteSource(null);
    setMoveSource(null);
    setMoveParentSourceId(null);
    setReadmeSource(null);
    setReadmeContent("");
    resetAddSourceDialog();
    setDirectoryParentSourceId(null);

    commitSources(sourceHydration.sources);
    void refreshSources();
  }, [
    commitSources,
    workspaceId,
    initialSources,
    initialSourcesLoaded,
    refreshSources,
    resetAddSourceDialog,
  ]);

  useEffect(() => {
    if (!workspaceId || !threadId || mode !== "thread") {
      setWorkfiles([]);
      setWorkfilesLoadingError(null);
      return;
    }

    const cached = threadWorkfilesCache.get(
      getThreadWorkfilesCacheKey(workspaceId, threadId),
    );
    if (cached) {
      setWorkfiles(cloneWorkfileItems(cached));
      setWorkfilesLoadingError(null);
      setIsLoadingWorkfiles(false);
      return;
    }

    void refreshWorkfiles();
  }, [mode, refreshWorkfiles, threadId, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setArtifacts([]);
      setArtifactsLoadingError(null);
      setArtifactsNextCursor(null);
      setIsLoadingMoreArtifacts(false);
      return;
    }

    const inMemoryCached = workspaceArtifactsCache.has(workspaceId)
      ? {
          items: workspaceArtifactsCache.get(workspaceId) ?? [],
          nextCursor: workspaceArtifactsCursorCache.get(workspaceId) ?? null,
        }
      : null;
    const cached =
      inMemoryCached ??
      getCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
        WORKSPACE_ARTIFACTS_CACHE_BUCKET,
        workspaceId,
      );
    if (cached) {
      workspaceArtifactsCache.set(
        workspaceId,
        cloneArtifactItems(cached.items),
      );
      workspaceArtifactsCursorCache.set(workspaceId, cached.nextCursor);
      setArtifacts(cloneArtifactItems(cached.items));
      setArtifactsNextCursor(cached.nextCursor);
      setArtifactsLoadingError(null);
      setIsLoadingArtifacts(false);
      setIsLoadingMoreArtifacts(false);
      void refreshArtifacts();
      return;
    }

    void refreshArtifacts();
  }, [refreshArtifacts, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      void refreshConnectors();
      return;
    }

    const cached = getCachedWorkspaceHubValue<WorkspaceConnectorsCacheValue>(
      WORKSPACE_CONNECTORS_CACHE_BUCKET,
      workspaceId,
    );
    if (cached) {
      setConnectors(cached.connectors);
      setConnectorAccounts(cached.accounts);
      setConnectorWebhookConfigsById(cached.webhookConfigsById);
      setConnectorWebhookEventsById(cached.webhookEventsById);
      setConnectorsLoadingError(null);
      setIsLoadingConnectors(false);
    }
    void refreshConnectors();
  }, [refreshConnectors, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      void refreshMcpInstalls();
      return;
    }

    const cached = getCachedWorkspaceHubValue<WorkspaceMcpCacheValue>(
      WORKSPACE_MCP_CACHE_BUCKET,
      workspaceId,
    );
    if (cached) {
      setMcpInstalls(cached.installs);
      setMcpLoadingError(null);
      setIsLoadingMcp(false);
    }
    void refreshMcpInstalls();
  }, [refreshMcpInstalls, workspaceId]);

  useEffect(() => {
    if (!connectorSettingsConnectorId) {
      setConnectorSettingsActivity([]);
      setConnectorSettingsActivityError(null);
      setIsLoadingConnectorSettingsActivity(false);
      return;
    }

    void refreshConnectorSettingsActivity(connectorSettingsConnectorId);
  }, [connectorSettingsConnectorId, refreshConnectorSettingsActivity]);

  useEffect(() => {
    if (!connectorSettingsConnectorId) return;
    const hasLiveActivity = connectorSettingsActivity.some((item) =>
      ["queued", "running", "received"].includes(item.status),
    );
    if (!hasLiveActivity) return;

    const timer = window.setInterval(() => {
      void refreshConnectorSettingsActivity(connectorSettingsConnectorId, {
        silent: true,
      });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    connectorSettingsActivity,
    connectorSettingsConnectorId,
    refreshConnectorSettingsActivity,
  ]);

  useEffect(() => {
    if (workfilesRefreshKey > 0) {
      void refreshWorkfiles();
    }
  }, [refreshWorkfiles, workfilesRefreshKey]);

  useEffect(() => {
    if (artifactsRefreshKey > 0) {
      void refreshArtifacts();
    }
  }, [artifactsRefreshKey, refreshArtifacts]);

  useEffect(() => {
    if (!workspaceId || pendingSourceIds.length === 0) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const { items: statuses } = await contentClient.listSourceStatuses(
          workspaceId,
          { ids: pendingSourceIds },
        );
        if (cancelled) {
          return;
        }

        const nextPending: string[] = [];
        let shouldRefresh = false;
        for (const result of statuses) {
          const current = result.status.status;
          if (current === "queued" || current === "processing") {
            nextPending.push(result.id);
            continue;
          }

          shouldRefresh = true;
          if (current === "failed") {
            toast.error("Source processing failed.");
          }
        }

        setPendingSourceIds(nextPending);
        if (shouldRefresh) {
          void refreshSources();
        }
      } catch {
        // Keep polling quietly; source listing refresh will surface errors.
      }
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, pendingSourceIds, refreshSources]);

  useEffect(() => {
    if (!workspaceId) {
      activeSyncRunsRef.current.clear();
      syncRunNeedsCooldownConfirmationRef.current = false;
      syncRunPollErrorCountRef.current = 0;
      return;
    }

    const activeWorkspaceId = workspaceId;
    const tabId = sourcesHubTabIdRef.current ?? createSourcesHubTabId();
    sourcesHubTabIdRef.current = tabId;
    const leaderCandidates = syncRunLeaderCandidatesRef.current;
    let cancelled = false;
    syncRunPollStoppedRef.current = false;

    function clearPollTimer() {
      if (syncRunPollTimerRef.current !== null) {
        window.clearTimeout(syncRunPollTimerRef.current);
        syncRunPollTimerRef.current = null;
      }
    }

    function clearHeartbeatTimer() {
      if (syncRunHeartbeatTimerRef.current !== null) {
        window.clearInterval(syncRunHeartbeatTimerRef.current);
        syncRunHeartbeatTimerRef.current = null;
      }
    }

    function postSyncRunMessage(message: ConnectorSyncRunBroadcastMessage) {
      syncRunChannelRef.current?.postMessage(message);
    }

    function updateSelfLeaderCandidate() {
      leaderCandidates.set(tabId, {
        id: tabId,
        lastSeenAt: Date.now(),
        visible: isDocumentVisible() && shouldPollConnectorSyncRuns(activeTab),
      });
    }

    function startLeaderHeartbeat() {
      if (syncRunHeartbeatTimerRef.current !== null) {
        return;
      }
      postSyncRunMessage({
        type: "leader-heartbeat",
        tabId,
        visible: isDocumentVisible(),
        sentAt: Date.now(),
      });
      syncRunHeartbeatTimerRef.current = window.setInterval(() => {
        if (cancelled || !syncRunIsLeaderRef.current || !isDocumentVisible()) {
          return;
        }
        postSyncRunMessage({
          type: "leader-heartbeat",
          tabId,
          visible: true,
          sentAt: Date.now(),
        });
      }, SYNC_RUN_LEADER_HEARTBEAT_MS);
    }

    function setSyncRunLeader(value: boolean) {
      if (syncRunIsLeaderRef.current === value) {
        return;
      }
      syncRunIsLeaderRef.current = value;
      if (value) {
        startLeaderHeartbeat();
        requestSyncRunPollRef.current?.(0);
      } else {
        clearHeartbeatTimer();
      }
    }

    function electSyncRunLeader() {
      updateSelfLeaderCandidate();
      const leaderId = selectConnectorSyncRunLeader(
        Array.from(leaderCandidates.values()),
        Date.now(),
      );
      setSyncRunLeader(leaderId === tabId);
    }

    function requestSyncRunPoll(delayMs = 0) {
      if (
        cancelled ||
        syncRunPollStoppedRef.current ||
        !shouldPollConnectorSyncRuns(activeTab) ||
        (syncRunChannelRef.current && !syncRunIsLeaderRef.current)
      ) {
        return;
      }
      clearPollTimer();
      syncRunPollTimerRef.current = window.setTimeout(() => {
        syncRunPollTimerRef.current = null;
        void pollActiveSyncRuns();
      }, delayMs);
    }

    requestSyncRunPollRef.current = requestSyncRunPoll;

    function scheduleNextSyncRunPoll() {
      const decision = getConnectorSyncRunPollDecision({
        errorCount: syncRunPollErrorCountRef.current,
        hasActiveRuns: activeSyncRunsRef.current.size > 0,
        isVisible: isDocumentVisible(),
        needsCooldownConfirmation: syncRunNeedsCooldownConfirmationRef.current,
      });
      requestSyncRunPoll(decision.delayMs);
    }

    async function handleSyncRunResult(
      result: WorkspaceConnectorSyncRunsResult,
    ) {
      if (cancelled) {
        return;
      }

      const activeRunIds = new Set(result.items.map((run) => run.id));
      const incrementalRequests: Array<Promise<SourceItem[]>> = [];

      for (const run of result.items) {
        const connectorId = run.connectorId;
        if (!connectorId) {
          continue;
        }
        const tracked = activeSyncRunsRef.current.get(run.id) ?? {
          connectorId,
          discoveredCount: 0,
          indexedCount: 0,
          failedCount: 0,
          lastSourceUpdatedAt: null,
          hasFinalRefreshed: false,
        };
        const countsChanged =
          run.discoveredCount !== tracked.discoveredCount ||
          run.indexedCount !== tracked.indexedCount ||
          run.failedCount !== tracked.failedCount;
        activeSyncRunsRef.current.set(run.id, {
          ...tracked,
          connectorId,
          discoveredCount: run.discoveredCount,
          indexedCount: run.indexedCount,
          failedCount: run.failedCount,
        });

        if (!countsChanged && tracked.lastSourceUpdatedAt !== null) {
          continue;
        }

        const updatedAfter = getIncrementalUpdatedAfter(
          tracked.lastSourceUpdatedAt,
        );
        incrementalRequests.push(
          contentClient
            .listSources(activeWorkspaceId, {
              view: "tree",
              connectorId,
              syncRunId: run.id,
              ...(updatedAfter ? { updatedAfter } : {}),
            })
            .then((sourcesResult) => {
              const mapped = mapSourcesToUi(sourcesResult.items);
              const newestUpdatedAt = sourcesResult.items
                .map((item) => item.updatedAt)
                .filter(Boolean)
                .sort()
                .at(-1);
              const current = activeSyncRunsRef.current.get(run.id);
              if (current && newestUpdatedAt) {
                activeSyncRunsRef.current.set(run.id, {
                  ...current,
                  lastSourceUpdatedAt: newestUpdatedAt,
                });
              }
              return mapped;
            })
            .catch(() => []),
        );
      }

      const completedRuns = Array.from(
        activeSyncRunsRef.current.entries(),
      ).filter(
        ([runId, tracked]) =>
          !activeRunIds.has(runId) && !tracked.hasFinalRefreshed,
      );

      if (incrementalRequests.length > 0) {
        const batches = await Promise.all(incrementalRequests);
        if (!cancelled) {
          mergeIncrementalSources(batches.flat());
        }
      }

      if (completedRuns.length > 0) {
        const completedConnectorIds = new Set(
          completedRuns
            .map(([, tracked]) => tracked.connectorId)
            .filter((connectorId): connectorId is string =>
              Boolean(connectorId),
            ),
        );
        const activeConnectorIds = new Set(
          result.items
            .map((run) => run.connectorId)
            .filter((connectorId): connectorId is string =>
              Boolean(connectorId),
            ),
        );
        const finalRefreshes = Array.from(completedConnectorIds)
          .filter((connectorId) => !activeConnectorIds.has(connectorId))
          .map((connectorId) =>
            contentClient
              .listSources(activeWorkspaceId, {
                view: "tree",
                connectorId,
              })
              .then((sourcesResult) => ({
                connectorId,
                items: mapSourcesToUi(sourcesResult.items),
              }))
              .catch(() => ({ connectorId, items: [] })),
          );
        for (const [runId, tracked] of completedRuns) {
          activeSyncRunsRef.current.set(runId, {
            ...tracked,
            hasFinalRefreshed: true,
          });
        }
        if (finalRefreshes.length > 0) {
          const batches = await Promise.all(finalRefreshes);
          if (!cancelled) {
            replaceConnectorSources(batches);
          }
        }
        for (const [runId] of completedRuns) {
          activeSyncRunsRef.current.delete(runId);
        }
        if (!cancelled) {
          void refreshConnectors();
        }
      }

      if (result.items.length > 0) {
        syncRunNeedsCooldownConfirmationRef.current = false;
        return;
      }
      if (completedRuns.length > 0) {
        syncRunNeedsCooldownConfirmationRef.current = true;
        return;
      }
      syncRunNeedsCooldownConfirmationRef.current = false;
    }

    async function pollActiveSyncRuns() {
      if (
        cancelled ||
        !shouldPollConnectorSyncRuns(activeTab) ||
        syncRunPollStoppedRef.current
      ) {
        return;
      }
      if (!isDocumentVisible()) {
        scheduleNextSyncRunPoll();
        return;
      }
      if (syncRunChannelRef.current && !syncRunIsLeaderRef.current) {
        return;
      }
      if (syncRunPollInFlightRef.current) {
        requestSyncRunPoll(ACTIVE_SYNC_RUN_POLL_MS);
        return;
      }

      syncRunPollInFlightRef.current = true;
      try {
        const result = await connectorsClient.listWorkspaceSyncRuns(
          activeWorkspaceId,
          {
            status: "active",
          },
        );
        if (cancelled) {
          return;
        }
        syncRunPollErrorCountRef.current = 0;
        postSyncRunMessage({
          type: "sync-runs-result",
          tabId,
          sentAt: Date.now(),
          result,
        });
        await handleSyncRunResult(result);
      } catch {
        syncRunPollErrorCountRef.current += 1;
        // The regular connector/source refresh surfaces visible errors.
      } finally {
        syncRunPollInFlightRef.current = false;
        if (!cancelled) {
          scheduleNextSyncRunPoll();
        }
      }
    }

    if (!shouldPollConnectorSyncRuns(activeTab)) {
      return () => {
        requestSyncRunPollRef.current = null;
      };
    }

    function handleVisibilityChange() {
      updateSelfLeaderCandidate();
      postSyncRunMessage({
        type: "hello",
        tabId,
        visible: isDocumentVisible(),
        sentAt: Date.now(),
      });
      electSyncRunLeader();
      if (!isDocumentVisible()) {
        clearPollTimer();
        setSyncRunLeader(false);
        return;
      }
      if (syncRunIsLeaderRef.current) {
        requestSyncRunPoll(0);
      }
    }

    if (typeof BroadcastChannel !== "undefined") {
      try {
        const channel = new BroadcastChannel(
          `${CONNECTOR_SYNC_RUN_CHANNEL_PREFIX}:${activeWorkspaceId}`,
        );
        syncRunChannelRef.current = channel;
        channel.onmessage = (event: MessageEvent) => {
          const message = parseConnectorSyncRunBroadcastMessage(event.data);
          if (!message || message.tabId === tabId) {
            return;
          }
          if (message.type === "hello" || message.type === "leader-heartbeat") {
            leaderCandidates.set(message.tabId, {
              id: message.tabId,
              lastSeenAt: message.sentAt,
              visible: message.visible,
            });
            electSyncRunLeader();
            return;
          }
          if (message.type === "sync-runs-result") {
            syncRunPollErrorCountRef.current = 0;
            void handleSyncRunResult(message.result);
            return;
          }
          if (message.type === "sync-runs-wake") {
            if (syncRunIsLeaderRef.current) {
              requestSyncRunPoll(0);
            }
          }
        };
        updateSelfLeaderCandidate();
        postSyncRunMessage({
          type: "hello",
          tabId,
          visible: isDocumentVisible(),
          sentAt: Date.now(),
        });
        const electionTimer = window.setTimeout(() => {
          electSyncRunLeader();
        }, SYNC_RUN_LEADER_ELECTION_MS);
        syncRunLeaderTimerRef.current = window.setInterval(() => {
          electSyncRunLeader();
        }, SYNC_RUN_LEADER_CHECK_MS);
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", handleVisibilityChange);
        }
        return () => {
          cancelled = true;
          syncRunPollStoppedRef.current = true;
          window.clearTimeout(electionTimer);
          clearPollTimer();
          clearHeartbeatTimer();
          if (syncRunLeaderTimerRef.current !== null) {
            window.clearInterval(syncRunLeaderTimerRef.current);
            syncRunLeaderTimerRef.current = null;
          }
          if (typeof document !== "undefined") {
            document.removeEventListener(
              "visibilitychange",
              handleVisibilityChange,
            );
          }
          channel.close();
          syncRunChannelRef.current = null;
          syncRunIsLeaderRef.current = false;
          leaderCandidates.clear();
          if (requestSyncRunPollRef.current === requestSyncRunPoll) {
            requestSyncRunPollRef.current = null;
          }
        };
      } catch {
        syncRunChannelRef.current = null;
      }
    }

    syncRunIsLeaderRef.current = true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    requestSyncRunPoll(0);
    return () => {
      cancelled = true;
      syncRunPollStoppedRef.current = true;
      clearPollTimer();
      clearHeartbeatTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
      syncRunIsLeaderRef.current = false;
      if (requestSyncRunPollRef.current === requestSyncRunPoll) {
        requestSyncRunPollRef.current = null;
      }
    };
  }, [
    activeTab,
    mergeIncrementalSources,
    replaceConnectorSources,
    refreshConnectors,
    workspaceId,
  ]);

  useEffect(() => {
    const syncingIds = sources
      .filter(isSyncingSource)
      .map((source) => source.id);
    if (syncingIds.length === 0) {
      return;
    }

    setPendingSourceIds((prev) => {
      const next = Array.from(new Set([...prev, ...syncingIds]));
      return next.length === prev.length ? prev : next;
    });
  }, [sources]);

  useEffect(() => {
    setEditingSourceId((prev) => {
      if (!prev) return prev;
      return sources.some((s) => s.id === prev) ? prev : null;
    });

    if (sources.length === 0) {
      return;
    }

    const sourceIds = new Set(sources.map((s) => s.id));
    const nextSelected = normalizeSourceSelectionFromTree(
      fullSourceTree,
      selectedIds.filter((id) => sourceIds.has(id)),
    );
    if (!areStringArraysEqual(nextSelected, selectedIds)) {
      onSelectionChange(nextSelected);
    }
  }, [fullSourceTree, sources, selectedIds, onSelectionChange]);

  const tabCounts: Partial<Record<HubTab, number>> = {
    Sources: selectedSourceCoverageCount,
    Workfiles: workfiles.length,
    Artifacts: artifacts.length,
    Skills: selectedSkillIds.length,
    MCP: selectedMcpInstallIds.length + selectedMcpToolIds.length,
    Citations: citations.length,
    Connectors: connectors.length,
  };

  function handleToggle(node: SourceTreeNode) {
    onSelectionChange(
      normalizeSourceSelectionFromTree(
        fullSourceTree,
        toggleSourceSelectionInTree(fullSourceTree, node, selectedIds),
      ),
    );
  }

  function handleToggleAllSources() {
    if (allSelectableSourcesSelected) {
      onSelectionChange([]);
      return;
    }

    onSelectionChange(
      normalizeSourceSelectionFromTree(fullSourceTree, selectableSourceIds),
    );
  }

  function setRowBusy(id: string, busy: boolean) {
    setRowBusyById((prev) => {
      if (busy) return { ...prev, [id]: true };
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function setWorkfileBusy(path: string, busy: boolean) {
    setWorkfileBusyByPath((prev) => {
      if (busy) return { ...prev, [path]: true };
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }

  function setConnectorBusy(id: string, busy: boolean) {
    setConnectorBusyById((prev) => {
      if (busy) return { ...prev, [id]: true };
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function setConnectorWaiting(connectorType: string, waiting: boolean) {
    setConnectorWaitingByType((prev) => {
      if (waiting) {
        if (prev[connectorType]) return prev;
        return { ...prev, [connectorType]: true };
      }
      if (!prev[connectorType]) return prev;
      const next = { ...prev };
      delete next[connectorType];
      return next;
    });
  }

  const openConnectorSettings = useCallback((connector: ConnectorItem) => {
    setConnectorSettingsConnectorId(connector.id);
  }, []);

  const handleOpenConnectorSettingsById = useCallback(
    (connectorId: string) => {
      const connector = connectors.find((item) => item.id === connectorId);
      if (!connector) {
        toast.error("Connector settings are not available yet.");
        return;
      }
      openConnectorSettings(connector);
    },
    [connectors, openConnectorSettings],
  );

  const openManageConnectors = useCallback(
    (tab: ManageConnectorsTab = "all") => {
      setManageConnectorsInitialTab(tab);
      setIsManageConnectorsOpen(true);
    },
    [],
  );

  const markConnectorNotReady = useCallback(
    (connectorId: string, reason: string, message: string) => {
      setConnectorReadinessById((prev) => ({
        ...prev,
        [connectorId]: { reason, message },
      }));
    },
    [],
  );

  const clearConnectorReadiness = useCallback((connectorId: string) => {
    setConnectorReadinessById((prev) => {
      if (!prev[connectorId]) return prev;
      const next = { ...prev };
      delete next[connectorId];
      return next;
    });
  }, []);

  const handleConnectConnector = useCallback(
    (item: ConnectorCatalogItem) => {
      if (!workspaceId) {
        toast.error("No workspace selected yet.");
        return;
      }

      if (item.connectMode !== "oauth_connector") {
        toast.error(`${item.name} is not available for OAuth yet.`);
        return;
      }

      const startUrl = new URL(
        "/dashboard/connectors/oauth/start",
        window.location.origin,
      );
      startUrl.searchParams.set("workspace_id", workspaceId);
      startUrl.searchParams.set("connector_type", item.id);
      startUrl.searchParams.set("mode", "redirect");
      startUrl.searchParams.set("return_to", window.location.href);

      connectorWaitingStartedAtRef.current[item.id] = Date.now();
      setConnectorWaiting(item.id, true);
      openManageConnectors("all");
      toast.info(`Redirecting to ${item.name} authorization.`);
      window.location.assign(startUrl.toString());
    },
    [openManageConnectors, workspaceId],
  );

  const ensureConnector = useCallback(
    async (
      item: ConnectorCatalogItem,
      accountId?: string | null,
      options: { silentMissingAccount?: boolean } = {},
    ) => {
      if (!workspaceId) {
        return null;
      }
      if (item.connectMode !== "oauth_connector") {
        return null;
      }
      const current = connectors.find(
        (connector) =>
          connector.raw.connectorType === item.id &&
          connector.status !== "disabled",
      );
      if (current) {
        clearConnectorReadiness(current.id);
        setConnectorWaiting(item.id, false);
        return current;
      }

      if (item.postOAuthMode !== "auto_create") {
        await refreshConnectors();
        return null;
      }

      if (!accountId) {
        if (!options.silentMissingAccount) {
          toast.error(`Reconnect ${item.name} before creating a connector.`);
        }
        return null;
      }

      const requestKey = `${workspaceId}:${item.id}:${accountId}`;
      const existingRequest =
        ensureConnectorPromisesRef.current.get(requestKey);
      if (existingRequest) {
        return existingRequest;
      }

      const request = (async () => {
        setConnectorWaiting(item.id, true);
        try {
          const accounts = await connectorsClient.listAccounts(workspaceId, {
            connectorType: item.id,
          });
          const account = accounts.items.find((item) => item.id === accountId);
          if (!account) {
            if (!options.silentMissingAccount) {
              toast.error(
                `Reconnect ${item.name} before creating a connector.`,
              );
            }
            return null;
          }

          if (item.id !== "notion") {
            toast.info(`${item.name} is connected. Configure syncing next.`);
            await refreshConnectors();
            return null;
          }

          const created = await connectorsClient.create(workspaceId, {
            connectorType: "notion",
            name: account.displayName || "Notion",
            oauthAccountId: account.id,
            configJson: {
              includePages: true,
            },
            periodicIndexingEnabled: true,
            indexingFrequencyMinutes: 360,
          });
          const syncResult = await connectorsClient.sync(
            workspaceId,
            created.connector.id,
          );
          trackConnectorSyncRun(syncResult.run);
          trackManualConnectorSync(created.connector.id);
          if (syncResult.skipped) {
            markConnectorNotReady(
              created.connector.id,
              syncResult.reason ?? "connector_not_ready",
              syncResult.message ?? "Connector is not ready to sync.",
            );
            toast.info(syncResult.message ?? `${item.name} connected.`);
          } else if (syncResult.alreadyRunning) {
            toast.info(
              syncResult.message ?? `${item.name} sync is already running.`,
            );
          } else {
            clearConnectorReadiness(created.connector.id);
            toast.success(
              `${item.name} connector enabled. Initial sync queued.`,
            );
          }
          await refreshConnectors();
          return mapConnectorToUi(created.connector);
        } catch (error) {
          if (isConnectorAlreadyHandledError(error)) {
            await refreshConnectors();
            toast.success(`${item.name} connector is already connected.`);
            return null;
          }

          if (
            error instanceof HttpClientError &&
            error.code === "CONNECTOR_DISABLED_CONFLICT"
          ) {
            toast.error(
              "A disabled connector with this name already exists. Enable it or delete it before reconnecting.",
            );
          } else {
            toast.error(
              getErrorMessage(
                error,
                `Failed to enable ${item.name} connector.`,
              ),
            );
          }
          return null;
        } finally {
          setConnectorWaiting(item.id, false);
          ensureConnectorPromisesRef.current.delete(requestKey);
        }
      })();

      ensureConnectorPromisesRef.current.set(requestKey, request);
      return request;
    },
    [
      clearConnectorReadiness,
      connectors,
      markConnectorNotReady,
      refreshConnectors,
      trackConnectorSyncRun,
      trackManualConnectorSync,
      workspaceId,
    ],
  );

  const handleCreateConnector = useCallback(
    async (item: ConnectorCatalogItem) => {
      if (!workspaceId) {
        toast.error("No workspace selected yet.");
        return;
      }
      if (item.postOAuthMode === "auto_create") {
        handleConnectConnector(item);
        return;
      }
      await ensureConnector(item);
      openManageConnectors("all");
    },
    [
      ensureConnector,
      handleConnectConnector,
      openManageConnectors,
      workspaceId,
    ],
  );

  const handleConnectorOAuthCompletion = useCallback(
    (message: ConnectorOAuthCompletionMessage) => {
      if (!workspaceId || message.workspaceId !== workspaceId) {
        setConnectorWaiting(message.connectorType, false);
        return;
      }
      if (processedConnectorOAuthMessageIdsRef.current.has(message.id)) return;
      processedConnectorOAuthMessageIdsRef.current.add(message.id);

      const item = connectorCatalog.find(
        (candidate) => candidate.id === message.connectorType,
      );
      if (!item || item.connectMode !== "oauth_connector") {
        setConnectorWaiting(message.connectorType, false);
        return;
      }

      openManageConnectors("all");

      if (message.status === "error") {
        setConnectorWaiting(item.id, false);
        toast.error(message.error || `${item.name} authorization failed.`);
        void refreshConnectors();
        return;
      }

      if (item.postOAuthMode === "auto_create") {
        void ensureConnector(item, message.accountId);
        return;
      }

      setConnectorWaiting(item.id, false);
      toast.success(`${item.name} connected. Configure syncing next.`);
      void refreshConnectors();
    },
    [ensureConnector, openManageConnectors, refreshConnectors, workspaceId],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CONNECTOR_OAUTH_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const message = parseConnectorOAuthCompletionMessage(event.data);
        if (message) handleConnectorOAuthCompletion(message);
      };
    } catch {
      channel = null;
    }

    function handleStorage(event: StorageEvent) {
      if (event.key !== CONNECTOR_OAUTH_STORAGE_KEY || !event.newValue) return;
      try {
        const message = parseConnectorOAuthCompletionMessage(
          JSON.parse(event.newValue) as unknown,
        );
        if (message) handleConnectorOAuthCompletion(message);
      } catch {
        // Ignore malformed cross-tab messages.
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      channel?.close();
    };
  }, [handleConnectorOAuthCompletion]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const message = readConnectorOAuthCompletionFromUrl();
    if (!message) return;
    if (!workspaceId || message.workspaceId !== workspaceId) return;
    clearConnectorOAuthCompletionFromUrl();
    handleConnectorOAuthCompletion(message);
  }, [handleConnectorOAuthCompletion, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const activeWorkspaceId = workspaceId;
    const waitingTypes = Object.keys(connectorWaitingByType).filter(
      (value): value is string => Boolean(value),
    );
    if (waitingTypes.length === 0) return;

    function pollWaitingConnectors() {
      for (const connectorTypeValue of waitingTypes) {
        const connectorType = connectorTypeValue;
        const item = connectorCatalog.find(
          (candidate) => candidate.id === connectorType,
        );
        if (!item || item.connectMode !== "oauth_connector") {
          setConnectorWaiting(connectorType, false);
          continue;
        }
        const waitingStartedAt =
          connectorWaitingStartedAtRef.current[connectorType];
        if (!waitingStartedAt) {
          continue;
        }

        void connectorsClient
          .listAccounts(activeWorkspaceId, { connectorType })
          .then(async (accounts) => {
            const account = accounts.items.find(
              (candidate) =>
                candidate.status === "active" &&
                Date.parse(candidate.createdAt) >= waitingStartedAt,
            );
            if (!account) return;
            if (item.postOAuthMode === "auto_create") {
              await ensureConnector(item, account.id, {
                silentMissingAccount: true,
              });
              return;
            }
            setConnectorWaiting(connectorType, false);
            await refreshConnectors();
          })
          .catch(() => {
            // Polling is a fallback; the visible flow is driven by completion.
          });
      }
    }

    pollWaitingConnectors();
    const timer = window.setInterval(pollWaitingConnectors, 2500);

    return () => window.clearInterval(timer);
  }, [connectorWaitingByType, ensureConnector, refreshConnectors, workspaceId]);

  const handleRequestConnector = useCallback((item: ConnectorCatalogItem) => {
    toast.info(`${item.name} is on the roadmap.`);
  }, []);

  const handleCancelConnector = useCallback((item: ConnectorCatalogItem) => {
    delete connectorWaitingStartedAtRef.current[item.id];
    setConnectorWaiting(item.id, false);
    toast.info(`${item.name} connection canceled.`);
  }, []);

  const handleCopyWebhook = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Could not copy webhook URL.");
    }
  }, []);

  const handleSyncConnector = useCallback(
    async (connector: ConnectorItem) => {
      if (!workspaceId) return;

      setConnectorBusy(connector.id, true);
      trackManualConnectorSync(connector.id);
      try {
        const result = await connectorsClient.sync(workspaceId, connector.id);
        trackConnectorSyncRun(result.run);
        if (result.skipped) {
          markConnectorNotReady(
            connector.id,
            result.reason ?? "connector_not_ready",
            result.message ?? "Connector is not ready to sync.",
          );
          toast.info(result.message ?? "Connector sync skipped.");
        } else if (result.alreadyRunning) {
          toast.info(result.message ?? "Connector sync is already running.");
        } else {
          clearConnectorReadiness(connector.id);
          toast.success("Connector sync queued.");
        }
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to sync connector."));
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [
      clearConnectorReadiness,
      connectorSettingsConnectorId,
      markConnectorNotReady,
      refreshConnectorSettingsActivity,
      refreshConnectors,
      trackConnectorSyncRun,
      trackManualConnectorSync,
      workspaceId,
    ],
  );

  const handleToggleConnectorStatus = useCallback(
    async (connector: ConnectorItem) => {
      if (!workspaceId) return;
      const nextStatus =
        connector.status === "paused" || connector.status === "disabled"
          ? "active"
          : "paused";
      setConnectorBusy(connector.id, true);
      try {
        await connectorsClient.update(workspaceId, connector.id, {
          status: nextStatus,
        });
        toast.success(
          connector.status === "disabled"
            ? "Connector enabled."
            : nextStatus === "active"
              ? "Connector resumed."
              : "Connector paused.",
        );
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to update connector."));
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [
      connectorSettingsConnectorId,
      refreshConnectorSettingsActivity,
      refreshConnectors,
      workspaceId,
    ],
  );

  const handleSaveConnectorSettings = useCallback(
    async (
      connector: ConnectorItem,
      input: {
        name: string;
        periodicIndexingEnabled: boolean;
        indexingFrequencyMinutes: number | null;
      },
    ) => {
      if (!workspaceId) return;

      setConnectorBusy(connector.id, true);
      try {
        await connectorsClient.update(workspaceId, connector.id, input);
        toast.success("Connector settings saved.");
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(
          getErrorMessage(error, "Failed to save connector settings."),
        );
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [
      connectorSettingsConnectorId,
      refreshConnectorSettingsActivity,
      refreshConnectors,
      workspaceId,
    ],
  );

  const handleConfirmDisconnectConnector = useCallback(async () => {
    if (!workspaceId || !pendingDisconnectConnector) return;
    const connector = pendingDisconnectConnector;
    setConnectorBusy(connector.id, true);
    try {
      const result = await connectorsClient.delete(workspaceId, connector.id, {
        disable: !disconnectConnectorHardDelete,
      });
      toast.success(
        result.hardDeleted
          ? "Connector, authorization, and indexed content deleted."
          : "Connector disabled. You can enable it again later.",
      );
      setPendingDisconnectConnector(null);
      setDisconnectConnectorHardDelete(false);
      if (connectorSettingsConnectorId === connector.id) {
        setConnectorSettingsConnectorId(null);
      }
      if (result.hardDeleted) {
        await refreshSources();
      }
      await refreshConnectors();
    } catch (error) {
      if (
        error instanceof HttpClientError &&
        error.code === "CONNECTOR_OAUTH_ACCOUNT_IN_USE"
      ) {
        toast.error(
          "This authorization is attached to another connector and cannot be deleted safely.",
        );
      } else {
        toast.error(getErrorMessage(error, "Failed to remove connector."));
      }
    } finally {
      setConnectorBusy(connector.id, false);
    }
  }, [
    connectorSettingsConnectorId,
    disconnectConnectorHardDelete,
    pendingDisconnectConnector,
    refreshConnectors,
    refreshSources,
    workspaceId,
  ]);

  const handleStartRename = useCallback((source: SourceItem) => {
    setEditingSourceId(source.id);
    setEditingTitle(source.title);
  }, []);

  const handleCancelRename = useCallback(() => {
    setEditingSourceId(null);
    setEditingTitle("");
  }, []);

  const handleSubmitRename = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      const title = editingTitle.trim();
      if (!title) return;

      setRowBusy(id, true);
      try {
        await contentClient.updateSource(workspaceId, id, { title });
        toast.success("Source renamed.");
        setEditingSourceId(null);
        setEditingTitle("");
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to rename source."));
      } finally {
        setRowBusy(id, false);
      }
    },
    [workspaceId, editingTitle, refreshSources],
  );

  const handleRequestDeleteSource = useCallback((source: SourceItem) => {
    setDeleteSource(source);
  }, []);

  const handleConfirmDeleteSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.deleteSource(workspaceId, source.id);
        toast.success("Source deleted.");
        const deletedNode = findNodePath(fullSourceTree, source.id)?.at(-1);
        const deletedIds = new Set(
          deletedNode ? collectTreeIds(deletedNode) : [source.id],
        );
        onSelectionChange(selectedIds.filter((id) => !deletedIds.has(id)));
        setDeleteSource(null);
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to delete source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [
      workspaceId,
      fullSourceTree,
      refreshSources,
      onSelectionChange,
      selectedIds,
    ],
  );

  const handleConfirmDeleteSelectedSources = useCallback(async () => {
    if (!workspaceId || selectedSourceIdsForBulkDelete.length === 0) return;

    setIsDeletingSelectedSources(true);
    setRowBusyById((prev) => {
      const next = { ...prev };
      for (const sourceId of selectedSourceIdsForBulkDelete) {
        next[sourceId] = true;
      }
      return next;
    });
    try {
      const result = await contentClient.bulkDeleteSources(workspaceId, {
        sourceIds: selectedSourceIdsForBulkDelete,
      });
      const deletedIds = new Set<string>();
      for (const sourceId of result.sourceIds) {
        const node = findNodePath(fullSourceTree, sourceId)?.at(-1);
        for (const id of node ? collectTreeIds(node) : [sourceId]) {
          deletedIds.add(id);
        }
      }
      onSelectionChange(selectedIds.filter((id) => !deletedIds.has(id)));
      setDeleteSelectedSourcesOpen(false);
      toast.success(
        `Deleted ${result.deletedCount} selected source${
          result.deletedCount === 1 ? "" : "s"
        }.`,
      );
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to delete selected sources."));
    } finally {
      setIsDeletingSelectedSources(false);
      setRowBusyById((prev) => {
        const next = { ...prev };
        for (const sourceId of selectedSourceIdsForBulkDelete) {
          delete next[sourceId];
        }
        return next;
      });
    }
  }, [
    fullSourceTree,
    onSelectionChange,
    refreshSources,
    selectedIds,
    selectedSourceIdsForBulkDelete,
    workspaceId,
  ]);

  const handleRetrySource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.retrySource(workspaceId, source.id, {});
        setPendingSourceIds((prev) =>
          prev.includes(source.id) ? prev : [...prev, source.id],
        );
        toast.success("Source retry queued.");
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to retry source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [workspaceId, refreshSources],
  );

  const handleReindexSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.indexSource(workspaceId, source.id, {});
        setPendingSourceIds((prev) =>
          prev.includes(source.id) ? prev : [...prev, source.id],
        );
        toast.success("Re-index queued.");
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to re-index source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [workspaceId, refreshSources],
  );

  const handlePreviewSource = useCallback((source: SourceItem) => {
    if (source.sourceType === "directory") return;
    setPreviewSource(source);
  }, []);

  const handlePreviewArtifact = useCallback(
    (artifact: ArtifactListItem) => {
      onArtifactOpen?.(artifact);
    },
    [onArtifactOpen],
  );

  const handleOpenReadmeDialog = useCallback(
    async (source: SourceItem) => {
      if (source.sourceType !== "directory") return;
      setReadmeSource(source);
      setReadmeContent(source.contentText);

      if (!workspaceId) return;

      try {
        const detail = await contentClient.getSource(workspaceId, source.id);
        setReadmeContent(detail.source.contentText);
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to load README content."));
      }
    },
    [workspaceId],
  );

  const handleOpenCreateDirectory = useCallback(
    (parentSourceId: string | null = null) => {
      setDirectoryParentSourceId(parentSourceId);
      setDirectoryTitle("");
      setDirectoryContext("");
      setIsCreateDirectoryOpen(true);
    },
    [],
  );

  const handleCreateDirectory = useCallback(async () => {
    if (!workspaceId) return;
    const title = directoryTitle.trim();
    if (!title) {
      toast.error("Folder name is required.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await contentClient.createSource(workspaceId, {
        sourceType: "directory",
        parentSourceId: directoryParentSourceId,
        title,
        contentText: directoryContext.trim() || undefined,
      });
      if (directoryContext.trim()) {
        await contentClient.indexSource(workspaceId, created.source.id, {});
        setPendingSourceIds((prev) =>
          prev.includes(created.source.id)
            ? prev
            : [...prev, created.source.id],
        );
      }
      selectNewSourceIds([created.source.id]);
      toast.success("Folder created.");
      setIsCreateDirectoryOpen(false);
      setDirectoryTitle("");
      setDirectoryContext("");
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create folder."));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    workspaceId,
    directoryTitle,
    directoryContext,
    directoryParentSourceId,
    refreshSources,
    selectNewSourceIds,
  ]);

  const handleUpdateReadme = useCallback(async () => {
    if (!workspaceId || !readmeSource) return;

    setIsSubmitting(true);
    setRowBusy(readmeSource.id, true);
    try {
      await contentClient.updateSource(workspaceId, readmeSource.id, {
        contentText: readmeContent,
      });
      toast.success("README updated.");
      setReadmeSource(null);
      setReadmeContent("");
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to update README."));
    } finally {
      setIsSubmitting(false);
      setRowBusy(readmeSource.id, false);
    }
  }, [workspaceId, readmeSource, readmeContent, refreshSources]);

  const handleOpenMoveDialog = useCallback((source: SourceItem) => {
    setMoveSource(source);
    setMoveParentSourceId(source.parentSourceId);
  }, []);

  const handleMoveSource = useCallback(async () => {
    if (!workspaceId || !moveSource) return;
    setRowBusy(moveSource.id, true);
    setIsSubmitting(true);
    try {
      await contentClient.updateSource(workspaceId, moveSource.id, {
        parentSourceId: moveParentSourceId,
      });
      toast.success("Source moved.");
      setMoveSource(null);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to move source."));
    } finally {
      setIsSubmitting(false);
      setRowBusy(moveSource.id, false);
    }
  }, [workspaceId, moveSource, moveParentSourceId, refreshSources]);

  const handleDownloadSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;
      if (!source.storageKey) {
        toast.error("This source has no original uploaded file.");
        return;
      }

      const link = document.createElement("a");
      link.href = `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(source.id)}/download`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
    [workspaceId],
  );

  const handleOpenWorkfile = useCallback(
    async (file: WorkfileListItem) => {
      if (!workspaceId || !threadId) return;

      setWorkfileBusy(file.path, true);
      try {
        const result = await contentClient.getWorkingFile(
          workspaceId,
          threadId,
          file.path,
        );
        setPreviewWorkfile(result.file);
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to load workfile."));
      } finally {
        setWorkfileBusy(file.path, false);
      }
    },
    [threadId, workspaceId],
  );

  const handleConfirmDeleteWorkfile = useCallback(async () => {
    if (!workspaceId || !threadId || !deleteWorkfile) return;

    setWorkfileBusy(deleteWorkfile.path, true);
    try {
      await contentClient.deleteWorkingFile(
        workspaceId,
        threadId,
        deleteWorkfile.path,
      );
      toast.success("Workfile deleted.");
      setDeleteWorkfile(null);
      if (previewWorkfile?.path === deleteWorkfile.path) {
        setPreviewWorkfile(null);
      }
      await refreshWorkfiles();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to delete workfile."));
    } finally {
      setWorkfileBusy(deleteWorkfile.path, false);
    }
  }, [
    deleteWorkfile,
    previewWorkfile?.path,
    refreshWorkfiles,
    threadId,
    workspaceId,
  ]);

  const handleCreateTextSource = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }

    const contentText = addSourceDialog.textContent.trim();
    if (!contentText) {
      toast.error("Source content cannot be empty.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await contentClient.createSource(workspaceId, {
        title: addSourceDialog.textTitle.trim() || undefined,
        contentText,
        parentSourceId: addSourceDialog.parentSourceId,
      });

      await contentClient.indexSource(workspaceId, created.source.id, {});
      setPendingSourceIds((prev) =>
        prev.includes(created.source.id) ? prev : [...prev, created.source.id],
      );
      selectNewSourceIds([created.source.id]);

      toast.success("Source added and indexing started.");
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create source."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources, selectNewSourceIds]);

  const handleCreateUrlSource = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }

    const url = addSourceDialog.urlValue.trim();
    if (!url) {
      toast.error("URL cannot be empty.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await contentClient.createUrlSource(workspaceId, {
        url,
        title: addSourceDialog.urlTitle.trim() || undefined,
        parentSourceId: addSourceDialog.parentSourceId,
      });

      setPendingSourceIds((prev) =>
        prev.includes(created.source.id) ? prev : [...prev, created.source.id],
      );
      selectNewSourceIds([created.source.id]);

      toast.success("URL source added. Processing started.");
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to add URL source."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources, selectNewSourceIds]);

  const handleUploadFiles = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    if (addSourceDialog.files.length === 0) {
      toast.error("Select files to upload first.");
      return;
    }

    setIsSubmitting(true);
    addSourceDialog.setUploadProgress(0);
    const createdSourceIds: string[] = [];
    const total = addSourceDialog.files.length;
    let processed = 0;

    try {
      for (const file of addSourceDialog.files) {
        const result = await contentClient.uploadSource(workspaceId, file, {
          parentSourceId: addSourceDialog.parentSourceId,
        });
        createdSourceIds.push(result.source.id);
        processed += 1;
        addSourceDialog.setUploadProgress(
          Math.round((processed / total) * 100),
        );
      }

      if (createdSourceIds.length > 0) {
        setPendingSourceIds((prev) =>
          Array.from(new Set([...prev, ...createdSourceIds])),
        );
        selectNewSourceIds(createdSourceIds);
      }

      toast.success(
        createdSourceIds.length === 1
          ? "1 source uploaded. Processing started."
          : `${createdSourceIds.length} sources uploaded. Processing started.`,
      );
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to upload files."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources, selectNewSourceIds]);

  return (
    <>
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col overflow-x-hidden bg-background",
          variant === "drawer" ? "w-full min-w-0" : "w-[410px] border-l",
        )}
      >
        <div className="min-w-0 shrink-0 border-b px-3 py-3">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">Hub</h2>
            <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5">
              {pendingSourceIds.length > 0 ? (
                <span className="inline-flex max-w-32 items-center gap-1 truncate text-[10px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  syncing {pendingSourceIds.length}
                </span>
              ) : null}
              {onClose ? (
                <Button
                  aria-label="Close Hub"
                  className="size-7"
                  onClick={onClose}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>

          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 rounded-xl bg-muted/35 pr-8 pl-8 text-xs sm:pr-20"
              onChange={(e) => setActiveSearchQuery(e.target.value)}
              placeholder={searchPlaceholders[activeTab]}
              value={searchQuery}
            />
            <span className="pointer-events-none absolute top-1/2 right-7 hidden -translate-y-1/2 rounded-md bg-background/75 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border/60 sm:inline-flex">
              {searchScopeLabels[activeTab]}
            </span>
            {searchQuery && (
              <button
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setActiveSearchQuery("")}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="mt-2 flex max-w-full flex-nowrap gap-1 overflow-x-auto overscroll-x-contain border-t pt-2">
            {tabs.map((tab) => (
              <button
                className={cn(
                  "inline-flex shrink-0 items-center justify-center rounded-lg border px-2 py-1 text-[11px] whitespace-nowrap transition-colors",
                  activeTab === tab
                    ? "border-border bg-secondary text-foreground shadow-xs"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                key={tab}
                onClick={() => handleActiveTabChange(tab)}
                type="button"
              >
                <span>{tab}</span>
                {tabCounts[tab] !== undefined ? (
                  <span className="ml-1.5 text-[10px] text-current/70">
                    {tabCounts[tab]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-x-hidden px-3 py-3",
            activeTab === "Sources" ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          {activeTab === "Sources" && (
            <section className="flex h-full min-h-0 flex-col space-y-1">
              <div className="mb-2 flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Sources
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {sources.length}
                  </span>
                  {deferredSearchQueries.Sources ? (
                    <span className="text-[10px] text-primary">
                      {filteredSourceCount} found
                    </span>
                  ) : null}
                </div>
                <div className="flex min-h-8 shrink-0 items-center justify-end gap-1.5">
                  <Button
                    disabled={isLoading}
                    onClick={() => void refreshSources()}
                    size="icon-xs"
                    title="Refresh sources"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw
                      className={cn("size-3.5", isLoading && "animate-spin")}
                    />
                    <span className="sr-only">Refresh sources</span>
                  </Button>
                  <Button
                    disabled={selectableSourceIds.length === 0}
                    onClick={handleToggleAllSources}
                    size="icon-xs"
                    title={
                      allSelectableSourcesSelected
                        ? "Unselect all sources"
                        : "Select all sources"
                    }
                    type="button"
                    variant="ghost"
                  >
                    {allSelectableSourcesSelected ? (
                      <SquareMinus className="size-3.5" />
                    ) : (
                      <SquareCheckBig className="size-3.5" />
                    )}
                    <span className="sr-only">
                      {allSelectableSourcesSelected
                        ? "Unselect all sources"
                        : "Select all sources"}
                    </span>
                  </Button>
                  <Button
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={
                      selectedSourceIdsForBulkDelete.length === 0 ||
                      isDeletingSelectedSources
                    }
                    onClick={() => setDeleteSelectedSourcesOpen(true)}
                    size="icon-xs"
                    title="Delete selected sources"
                    type="button"
                    variant="ghost"
                  >
                    {isDeletingSelectedSources ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    <span className="sr-only">Delete selected sources</span>
                  </Button>
                  <Button
                    onClick={() => handleOpenCreateDirectory(null)}
                    size="icon-xs"
                    title="Create folder"
                    type="button"
                    variant="ghost"
                  >
                    <FolderPlus className="size-3.5" />
                    <span className="sr-only">Create folder</span>
                  </Button>
                  <Button
                    onClick={() => addSourceDialog.open(null)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <Upload className="size-3.5" />
                    Add source
                  </Button>
                </div>
              </div>

              {loadingError ? (
                <Alert className="mb-2" variant="destructive">
                  <AlertDescription>{loadingError}</AlertDescription>
                </Alert>
              ) : null}

              {isLoading ? (
                <div className="flex min-h-0 flex-1 items-center justify-center py-6 text-xs text-muted-foreground">
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Loading sources...
                </div>
              ) : (
                <div className="min-h-0 flex-1">
                  <SourcesTab
                    editingId={editingSourceId}
                    editingTitle={editingTitle}
                    expandedDirectoryIds={expandedDirectoryIds}
                    onCancelRename={handleCancelRename}
                    onDelete={handleRequestDeleteSource}
                    onDownload={handleDownloadSource}
                    onEditReadme={handleOpenReadmeDialog}
                    onEditTitleChange={setEditingTitle}
                    onAddSource={addSourceDialog.open}
                    onCreateDirectory={handleOpenCreateDirectory}
                    onDirectoryExpandedChange={handleDirectoryExpandedChange}
                    onMove={handleOpenMoveDialog}
                    onPreview={handlePreviewSource}
                    onReindex={handleReindexSource}
                    onRetry={handleRetrySource}
                    onOpenConnectorSettings={handleOpenConnectorSettingsById}
                    onStartRename={handleStartRename}
                    onSubmitRename={handleSubmitRename}
                    onToggle={handleToggle}
                    rowBusyById={rowBusyById}
                    searchQuery={deferredSearchQuery}
                    selectedIds={selectedIds}
                    sourceTreeIndex={sourceTreeIndex}
                    userCollapsedDirectoryIds={userCollapsedDirectoryIds}
                  />
                </div>
              )}
            </section>
          )}

          {activeTab === "Workfiles" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Workfiles
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {workfiles.length} workfiles
                  </span>
                  {deferredSearchQueries.Workfiles ? (
                    <span className="text-[10px] text-primary">
                      {filteredWorkfileCount} found
                    </span>
                  ) : null}
                </div>
                <Button
                  onClick={() => void refreshWorkfiles()}
                  size="icon-xs"
                  title="Refresh workfiles"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" />
                  <span className="sr-only">Refresh workfiles</span>
                </Button>
              </div>
              <WorkfilesTab
                files={workfiles}
                isLoading={isLoadingWorkfiles}
                loadingError={workfilesLoadingError}
                onDelete={setDeleteWorkfile}
                onOpen={handleOpenWorkfile}
                onRefresh={() => void refreshWorkfiles()}
                rowBusyByPath={workfileBusyByPath}
                searchQuery={deferredSearchQuery}
              />
            </section>
          )}

          {activeTab === "Artifacts" && (
            <section className="space-y-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Artifacts
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {artifacts.length} artifacts
                  </span>
                  {deferredSearchQueries.Artifacts ? (
                    <span className="text-[10px] text-primary">
                      {filteredArtifactCount} found
                    </span>
                  ) : null}
                </div>
                <Button
                  className="size-7"
                  onClick={() => void refreshArtifacts()}
                  size="icon-xs"
                  title="Refresh artifacts"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" />
                  <span className="sr-only">Refresh artifacts</span>
                </Button>
              </div>
              <ArtifactsTab
                artifacts={artifacts}
                hasMore={Boolean(artifactsNextCursor)}
                isLoading={isLoadingArtifacts}
                isLoadingMore={isLoadingMoreArtifacts}
                loadingError={artifactsLoadingError}
                onLoadMore={() => void loadMoreArtifacts()}
                onPreview={handlePreviewArtifact}
                onRefresh={() => void refreshArtifacts()}
                searchQuery={deferredSearchQuery}
                workspaceId={workspaceId}
              />
            </section>
          )}

          {activeTab === "Skills" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Skills
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {skillsForHub.length} available
                  </span>
                  {deferredSearchQueries.Skills ? (
                    <span className="text-[10px] text-primary">
                      {filteredSkillCount} found
                    </span>
                  ) : null}
                  {selectedSkillIds.length > 0 ? (
                    <span className="text-[10px] text-primary">
                      {selectedSkillIds.length} selected
                    </span>
                  ) : null}
                </div>
                <Button
                  onClick={() => setIsSkillsGalleryOpen(true)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <SkillIcon className="size-3.5" />
                  Skills gallery
                </Button>
              </div>

              <SkillsTab
                disabledToolNames={disabledToolNames}
                onOpenSkill={setPreviewSkillCatalogId}
                onSkillSelectionChange={onSkillSelectionChange}
                onWorkspaceSkillEnabledChange={
                  handleWorkspaceSkillEnabledChange
                }
                searchQuery={deferredSearchQuery}
                selectedSkillIds={selectedSkillIds}
                skillIconsById={skillIconsById}
                skills={skillsForHub}
              />
            </section>
          )}

          {activeTab === "MCP" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">MCP</h3>
                  <span className="text-[10px] text-muted-foreground">
                    {mcpInstalls.length} installed
                  </span>
                  {selectedMcpInstallIds.length + selectedMcpToolIds.length >
                  0 ? (
                    <span className="text-[10px] text-primary">
                      {selectedMcpInstallIds.length + selectedMcpToolIds.length}{" "}
                      selected
                    </span>
                  ) : null}
                </div>
                <Button asChild size="xs" type="button" variant="outline">
                  <a href="/dashboard/mcp">
                    <McpIcon className="size-3.5" />
                    MCP Market
                  </a>
                </Button>
              </div>

              <McpTab
                installs={mcpInstalls}
                isLoading={isLoadingMcp}
                loadingError={mcpLoadingError}
                onRefresh={() => void refreshMcpInstalls()}
                onSelectionChange={onMcpSelectionChange}
                searchQuery={deferredSearchQuery}
                selectedInstallIds={selectedMcpInstallIds}
                selectedToolIds={selectedMcpToolIds}
              />
            </section>
          )}

          {activeTab === "Citations" && (
            <CitationsTab
              activeCitationChunkId={activeCitationChunkId}
              activeCitationIndex={activeCitationIndex}
              activeCitationItems={activeCitationItems}
              citationScope={citationScope}
              currentCitationItems={currentCitationItems}
              currentCitationMessageId={currentCitationMessageId}
              filteredCitationItems={filteredCitationItems}
              mode={mode}
              onCitationLocate={onCitationLocate}
              onCitationOpen={onCitationOpen}
              onScopeChange={setCitationScope}
              searchQuery={deferredSearchQueries.Citations}
              threadCitationItems={threadCitationItems}
            />
          )}

          {activeTab === "Connectors" && (
            <ConnectorsTab
              connectorBusyById={connectorBusyById}
              connectorReadinessById={connectorReadinessById}
              connectors={connectors}
              isLoading={isLoadingConnectors}
              loadingError={connectorsLoadingError}
              onConfigureConnector={openConnectorSettings}
              onManageConnectors={() => openManageConnectors("all")}
              onSyncConnector={(connector) =>
                void handleSyncConnector(connector)
              }
              onToggleConnectorStatus={(connector) =>
                void handleToggleConnectorStatus(connector)
              }
              webhookConfigsById={connectorWebhookConfigsById}
            />
          )}
        </div>
      </aside>

      <ManageConnectorsDialog
        accounts={connectorAccounts}
        connectorBusyById={connectorBusyById}
        connectorReadinessById={connectorReadinessById}
        connectors={connectors}
        connectorWaitingByType={connectorWaitingByType}
        initialTab={manageConnectorsInitialTab}
        isLoading={isLoadingConnectors}
        loadingError={connectorsLoadingError}
        onCancelConnector={handleCancelConnector}
        onConnectConnector={handleConnectConnector}
        onCopyWebhook={handleCopyWebhook}
        onCreateConnector={(item) => void handleCreateConnector(item)}
        onDisconnectConnector={setPendingDisconnectConnector}
        onOpenChange={setIsManageConnectorsOpen}
        onOpenSettings={openConnectorSettings}
        onRequestConnector={handleRequestConnector}
        onSyncConnector={(connector) => void handleSyncConnector(connector)}
        onToggleConnectorStatus={(connector) =>
          void handleToggleConnectorStatus(connector)
        }
        open={isManageConnectorsOpen}
        webhookConfigsById={connectorWebhookConfigsById}
        webhookEventsByConnectorId={connectorWebhookEventsById}
      />

      <ConnectorSettingsDialog
        activity={connectorSettingsActivity}
        activityError={connectorSettingsActivityError}
        connector={connectorSettingsConnector}
        connectorBusyById={connectorBusyById}
        connectorReadinessById={connectorReadinessById}
        isLoadingActivity={isLoadingConnectorSettingsActivity}
        onCopyWebhook={handleCopyWebhook}
        onDisconnect={setPendingDisconnectConnector}
        onOpenChange={(open) => {
          if (!open) {
            setConnectorSettingsConnectorId(null);
          }
        }}
        onSaveSettings={(connector, input) =>
          void handleSaveConnectorSettings(connector, input)
        }
        onSyncConnector={(connector) => void handleSyncConnector(connector)}
        onToggleStatus={(connector) =>
          void handleToggleConnectorStatus(connector)
        }
        open={Boolean(connectorSettingsConnector)}
        webhookConfig={
          connectorSettingsConnector
            ? (connectorWebhookConfigsById[connectorSettingsConnector.id] ??
              null)
            : null
        }
      />

      <AddSourceDialog
        addParentSourceId={addSourceDialog.parentSourceId}
        addTab={addSourceDialog.tab}
        fileInputRef={addSourceDialog.fileInputRef}
        files={addSourceDialog.files}
        isDragActive={addSourceDialog.isDragActive}
        isOpen={addSourceDialog.isOpen}
        isSubmitting={isSubmitting}
        onAddFiles={addSourceDialog.addFiles}
        onAddTabChange={addSourceDialog.setTab}
        onClose={addSourceDialog.close}
        onCreateTextSource={() => void handleCreateTextSource()}
        onCreateUrlSource={() => void handleCreateUrlSource()}
        onDragEnter={addSourceDialog.handleDragEnter}
        onDragLeave={addSourceDialog.handleDragLeave}
        onDragOver={addSourceDialog.handleDragOver}
        onDrop={addSourceDialog.handleDrop}
        onRemoveFile={addSourceDialog.removeFile}
        onTextContentChange={addSourceDialog.setTextContent}
        onTextTitleChange={addSourceDialog.setTextTitle}
        onUploadFiles={() => void handleUploadFiles()}
        onUrlTitleChange={addSourceDialog.setUrlTitle}
        onUrlValueChange={addSourceDialog.setUrlValue}
        sources={sources}
        textContent={addSourceDialog.textContent}
        textTitle={addSourceDialog.textTitle}
        uploadProgress={addSourceDialog.uploadProgress}
        urlTitle={addSourceDialog.urlTitle}
        urlValue={addSourceDialog.urlValue}
      />

      <CreateDirectoryDialog
        directoryContext={directoryContext}
        directoryParentSourceId={directoryParentSourceId}
        directoryTitle={directoryTitle}
        isOpen={isCreateDirectoryOpen}
        isSubmitting={isSubmitting}
        onContextChange={setDirectoryContext}
        onCreate={() => void handleCreateDirectory()}
        onOpenChange={setIsCreateDirectoryOpen}
        onParentChange={setDirectoryParentSourceId}
        onTitleChange={setDirectoryTitle}
        sources={sources}
      />

      <MoveSourceDialog
        isSubmitting={isSubmitting}
        moveParentSourceId={moveParentSourceId}
        moveSource={moveSource}
        onMove={() => void handleMoveSource()}
        onMoveSourceChange={setMoveParentSourceId}
        onOpenChange={(open) => {
          if (!open) {
            setMoveSource(null);
            setMoveParentSourceId(null);
          }
        }}
        sources={sources}
      />

      <ReadmeDialog
        isSubmitting={isSubmitting}
        onContentChange={setReadmeContent}
        onOpenChange={(open) => {
          if (!open) {
            setReadmeSource(null);
            setReadmeContent("");
          }
        }}
        onSave={() => void handleUpdateReadme()}
        readmeContent={readmeContent}
        readmeSource={readmeSource}
      />

      <SourcePreviewPanel
        onOpenChange={(open) => {
          if (!open) {
            setPreviewSource(null);
          }
        }}
        open={Boolean(previewSource)}
        source={previewSource}
        workspaceId={workspaceId}
      />

      <WorkfilePreviewDialog
        onOpenChange={(open) => {
          if (!open) {
            setPreviewWorkfile(null);
          }
        }}
        previewWorkfile={previewWorkfile}
      />

      <DeleteSourceDialog
        deleteSource={deleteSource}
        onConfirm={(source) => void handleConfirmDeleteSource(source)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteSource(null);
          }
        }}
        rowBusyById={rowBusyById}
      />

      <DeleteSelectedSourcesDialog
        count={selectedSourceIdsForBulkDelete.length}
        isDeleting={isDeletingSelectedSources}
        onConfirm={() => void handleConfirmDeleteSelectedSources()}
        onOpenChange={(open) => {
          if (!isDeletingSelectedSources) {
            setDeleteSelectedSourcesOpen(open);
          }
        }}
        open={deleteSelectedSourcesOpen}
      />

      <DeleteWorkfileDialog
        deleteWorkfile={deleteWorkfile}
        onConfirm={() => void handleConfirmDeleteWorkfile()}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteWorkfile(null);
          }
        }}
        workfileBusyByPath={workfileBusyByPath}
      />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingDisconnectConnector(null);
            setDisconnectConnectorHardDelete(false);
          }
        }}
        open={Boolean(pendingDisconnectConnector)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Manage connector removal</AlertDialogTitle>
            <AlertDialogDescription>
              Choose whether to temporarily disable this connector or
              permanently delete it from SourceWeft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDisconnectConnector ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
              <span className="line-clamp-2 break-words">
                {getConnectorDisplayName(pendingDisconnectConnector)}
              </span>
            </div>
          ) : null}
          <div className="space-y-2">
            <button
              className={cn(
                "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                !disconnectConnectorHardDelete
                  ? "border-primary bg-primary/5"
                  : "hover:bg-accent/60",
              )}
              onClick={() => setDisconnectConnectorHardDelete(false)}
              type="button"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  !disconnectConnectorHardDelete && "border-primary bg-primary",
                )}
              >
                {!disconnectConnectorHardDelete ? (
                  <span className="size-1.5 rounded-full bg-primary-foreground" />
                ) : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  Disable connector
                </span>
                <span className="block text-xs text-muted-foreground">
                  Stops syncing. Keeps authorization, configuration, history,
                  and indexed content. You can enable it again later.
                </span>
              </span>
            </button>
            <button
              className={cn(
                "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                disconnectConnectorHardDelete
                  ? "border-destructive bg-destructive/5"
                  : "hover:bg-accent/60",
              )}
              onClick={() => setDisconnectConnectorHardDelete(true)}
              type="button"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  disconnectConnectorHardDelete &&
                    "border-destructive bg-destructive",
                )}
              >
                {disconnectConnectorHardDelete ? (
                  <span className="size-1.5 rounded-full bg-destructive-foreground" />
                ) : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-destructive">
                  Delete connector and all indexed content
                </span>
                <span className="block text-xs text-muted-foreground">
                  Permanently deletes this connector, its local authorization,
                  and all content imported by it. This cannot be undone.
                </span>
              </span>
            </button>
            <p className="text-xs text-muted-foreground">
              SourceWeft will not revoke access in the third-party provider.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={Boolean(
                pendingDisconnectConnector &&
                  connectorBusyById[pendingDisconnectConnector.id],
              )}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                disconnectConnectorHardDelete &&
                  buttonVariants({ variant: "destructive" }),
                "whitespace-normal text-center",
              )}
              disabled={Boolean(
                pendingDisconnectConnector &&
                  connectorBusyById[pendingDisconnectConnector.id],
              )}
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmDisconnectConnector();
              }}
            >
              {pendingDisconnectConnector &&
              connectorBusyById[pendingDisconnectConnector.id] ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {disconnectConnectorHardDelete
                    ? "Deleting..."
                    : "Disabling..."}
                </>
              ) : disconnectConnectorHardDelete ? (
                "Delete connector and content"
              ) : (
                "Disable connector"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SkillReadmeDialog
        catalogId={previewSkillCatalogId}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewSkillCatalogId(null);
          }
        }}
        open={Boolean(previewSkillCatalogId)}
        workspaceId={workspaceId}
      />

      <Dialog onOpenChange={setIsSkillsGalleryOpen} open={isSkillsGalleryOpen}>
        <DialogContent
          className="grid h-[min(780px,calc(100svh-2rem))] w-[min(1240px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
          constrainWidth={false}
        >
          <DialogHeader className="border-b px-5 py-4 text-left">
            <DialogTitle>Skills gallery</DialogTitle>
            <DialogDescription>
              Install reusable skills for{" "}
              {workspaceName || "the current workspace"}.
            </DialogDescription>
          </DialogHeader>
          <SkillsGallery
            className="min-h-0"
            lockWorkspace
            onCatalogChange={onSkillsCatalogChange}
            variant="modal"
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
