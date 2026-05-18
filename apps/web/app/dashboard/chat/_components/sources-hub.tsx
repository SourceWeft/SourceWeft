"use client";

import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  Globe2,
  HardDrive,
  Link2,
  Loader2,
  Mail,
  MessageSquare,
  Music2,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Play,
  Power,
  PowerOff,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  SquareCheckBig,
  SquareMinus,
  Table2,
  Trash2,
  Upload,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  HttpClientError,
  type ConnectorWebhookEvent,
  type GetNotionWebhookConfigResponse,
  type SourceConnector,
} from "@sourceweft/sdk";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
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
import { Button, buttonVariants } from "@sourceweft/ui-web/components/ui/button";
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
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { apiBaseUrl, connectorsClient, contentClient } from "../../../../lib/sdk";
import { SkillsGallery } from "../../skills/_components/skills-gallery";
import type { CitationRecord } from "./chat-canvas";
import { GeneratedImagePreview } from "./chat-canvas/generated-image-preview";
import { SourcePreviewPanel } from "./source-preview-panel";
import { expandSelectedSources, type SourceItem } from "./source-types";

const tabs = [
  "Sources",
  "Workfiles",
  "Artifacts",
  "Connectors",
  "Skills",
] as const;
const addTabs = ["File", "URL", "Text"] as const;
const HUB_ACTIVE_TAB_STORAGE_KEY = "chat:sources-hub:active-tab:v1";
const MAX_FILES = 20;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const SOURCE_TREE_INDENT_PX = 10;
const SOURCES_PAGE_SIZE = 200;
const SOURCE_ROOT_PARENT_KEY = "__root";
const SOURCE_TREE_VIRTUALIZE_THRESHOLD = 400;
const SOURCE_TREE_ROW_HEIGHT_PX = 40;
const SOURCE_TREE_OVERSCAN_ROWS = 12;
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
const SOURCE_FILE_ACCEPT = SOURCE_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(",");
const SOURCE_FILE_EXTENSION_SET = new Set<string>(SOURCE_FILE_EXTENSIONS);
const connectorCatalog: ConnectorCatalogItem[] = [
  {
    id: "notion",
    name: "Notion",
    category: "Knowledge & Docs",
    description: "Sync pages, data sources, comments, and write approved outputs.",
    capabilities: ["Pages", "Databases", "Webhooks", "Write actions"],
    connectMode: "oauth_connector",
    icon: BookOpen,
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "File Storage",
    description: "Search and sync Drive files from shared workspaces.",
    capabilities: ["Files", "Folders", "Permissions"],
    connectMode: "coming_soon",
    icon: HardDrive,
  },
  {
    id: "onedrive",
    name: "OneDrive",
    category: "File Storage",
    description: "Bring Microsoft 365 documents into SourceWeft.",
    capabilities: ["Files", "Folders", "Microsoft 365"],
    connectMode: "coming_soon",
    icon: Cloud,
  },
  {
    id: "dropbox",
    name: "Dropbox",
    category: "File Storage",
    description: "Sync Dropbox folders and project documents.",
    capabilities: ["Files", "Folders", "Sync"],
    connectMode: "coming_soon",
    icon: Cloud,
  },
  {
    id: "gmail",
    name: "Gmail",
    category: "Communication",
    description: "Search, read, draft, and send approved emails.",
    capabilities: ["Mail", "Drafts", "Actions"],
    connectMode: "coming_soon",
    icon: Mail,
  },
  {
    id: "slack",
    name: "Slack",
    category: "Communication",
    description: "Index channels and route approved workspace updates.",
    capabilities: ["Messages", "Channels", "Actions"],
    connectMode: "coming_soon",
    icon: MessageSquare,
  },
  {
    id: "linear",
    name: "Linear",
    category: "Projects & Data",
    description: "Search, read, and manage issues and projects.",
    capabilities: ["Issues", "Projects", "Actions"],
    connectMode: "coming_soon",
    icon: CircleAlert,
  },
  {
    id: "airtable",
    name: "Airtable",
    category: "Projects & Data",
    description: "Browse bases, tables, records, and structured knowledge.",
    capabilities: ["Tables", "Records", "Query"],
    connectMode: "coming_soon",
    icon: Table2,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    category: "Projects & Data",
    description: "Search and manage calendar context and events.",
    capabilities: ["Events", "Schedules", "Actions"],
    connectMode: "coming_soon",
    icon: CalendarDays,
  },
  {
    id: "wordpress",
    name: "WordPress",
    category: "Publishing",
    description: "Use posts and pages as source material and outputs.",
    capabilities: ["Posts", "Pages", "Publishing"],
    connectMode: "coming_soon",
    icon: Globe2,
  },
  {
    id: "ghost",
    name: "Ghost",
    category: "Publishing",
    description: "Read and draft publication content with approvals.",
    capabilities: ["Posts", "Drafts", "Publishing"],
    connectMode: "coming_soon",
    icon: Globe2,
  },
  {
    id: "devto",
    name: "Dev.to",
    category: "Publishing",
    description: "Connect technical articles and publication workflows.",
    capabilities: ["Articles", "Publishing", "Search"],
    connectMode: "coming_soon",
    icon: FileText,
  },
  {
    id: "hashnode",
    name: "Hashnode",
    category: "Publishing",
    description: "Bring developer blogs into the knowledge graph.",
    capabilities: ["Posts", "Blogs", "Publishing"],
    connectMode: "coming_soon",
    icon: Globe2,
  },
];
const connectorCatalogCategories: ConnectorCatalogCategory[] = [
  "Knowledge & Docs",
  "File Storage",
  "Communication",
  "Projects & Data",
  "Publishing",
];

type HubTab = (typeof tabs)[number] | "Citations";
type AddTab = (typeof addTabs)[number];
const hubTabValues = new Set<string>([...tabs, "Citations"]);
let lastHubActiveTab: HubTab = "Sources";

function readStoredHubTab() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const value = window.sessionStorage.getItem(HUB_ACTIVE_TAB_STORAGE_KEY);
    return value && hubTabValues.has(value) ? (value as HubTab) : null;
  } catch {
    return null;
  }
}

function persistHubTab(tab: HubTab) {
  lastHubActiveTab = tab;

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(HUB_ACTIVE_TAB_STORAGE_KEY, tab);
  } catch {
    // Ignore storage failures; the in-memory tab state still works.
  }
}

type SourceApiRecord = Awaited<
  ReturnType<typeof contentClient.listSources>
>["items"][number];
type CitationScope = "current" | "thread";
type SourceTreeNode = {
  source: SourceItem;
  children: SourceTreeNode[];
};

type SourceTreeIndex = {
  byParent: Map<string | null, SourceItem[]>;
};
type SourceParentCursorMap = Record<string, string | null>;
type SourceParentStatusMap = Record<string, boolean>;
type SourceParentErrorMap = Record<string, string>;
type SourceSelectionState = boolean | "indeterminate";
type WorkfileListItem = Awaited<
  ReturnType<typeof contentClient.listWorkingFiles>
>["items"][number];
type WorkfileDetail = Awaited<
  ReturnType<typeof contentClient.getWorkingFile>
>["file"];
type ConnectorAccountItem = Awaited<
  ReturnType<typeof connectorsClient.listAccounts>
>["items"][number];
export type ArtifactListItem = Awaited<
  ReturnType<typeof contentClient.listArtifacts>
>["items"][number];

const workspaceArtifactsCache = new Map<string, ArtifactListItem[]>();
const workspaceArtifactsCursorCache = new Map<string, string | null>();
const threadWorkfilesCache = new Map<string, WorkfileListItem[]>();

function cloneArtifactItems(items: ArtifactListItem[]) {
  return items.map((item) => ({ ...item }));
}

function cloneWorkfileItems(items: WorkfileListItem[]) {
  return items.map((item) => ({ ...item }));
}

function getThreadWorkfilesCacheKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

type DisplayCitationItem = {
  id: string;
  sourceTitle: string;
  messageLabel: string;
  excerpt: string;
  citationRecord: CitationRecord;
  messageId?: string;
};

type ConnectorItem = {
  id: string;
  name: string;
  status: "active" | "paused" | "error" | "disabled";
  meta: string;
  raw: SourceConnector;
};

type ConnectorWebhookEventItem = ConnectorWebhookEvent;
type NotionWebhookConfig = GetNotionWebhookConfigResponse;
type ConnectorCatalogCategory =
  | "Knowledge & Docs"
  | "File Storage"
  | "Communication"
  | "Projects & Data"
  | "Publishing";
type ConnectorConnectMode = "oauth_connector" | "coming_soon";
type ConnectorCatalogItem = {
  id: string;
  name: string;
  category: ConnectorCatalogCategory;
  description: string;
  capabilities: string[];
  connectMode: ConnectorConnectMode;
  icon: LucideIcon;
};
type ManageConnectorsTab = "all" | "active";
type ConnectorCatalogStatusKind =
  | "available"
  | "connected"
  | "active"
  | "needs_setup"
  | "syncing"
  | "error"
  | "coming_soon";
type ConnectorCatalogStatus = {
  kind: ConnectorCatalogStatusKind;
  label: string;
  detail: string;
};

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
  Citations: "Search citations...",
  Connectors: "Search connectors...",
};

const searchScopeLabels: Record<HubTab, string> = {
  Sources: "Sources",
  Workfiles: "Workfiles",
  Artifacts: "Artifacts",
  Skills: "Skills",
  Citations: "Citations",
  Connectors: "Connectors",
};

export type HubSkillItem = {
  id: string;
  catalogId: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  sourceType: "builtin" | "workspace_custom" | "team_custom";
  version: string;
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
  if (baseName.startsWith(".") && SOURCE_FILE_EXTENSION_SET.has(baseName.slice(1))) {
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
    ["avif", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"].includes(
      extension,
    )
  ) {
    return "IMG";
  }
  if (
    ["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"].includes(
      extension,
    )
  ) {
    return "AUDIO";
  }
  return "TEXT";
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
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

function artifactTypeLabel(type: ArtifactListItem["artifactType"]) {
  if (type === "audio_overview") return "Audio";
  if (type === "video_overview") return "Video";
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function artifactTitle(artifact: ArtifactListItem) {
  return artifact.title?.trim() || artifactTypeLabel(artifact.artifactType);
}

function resolveArtifactFileUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;

  if (artifact.previewUrl) {
    return artifact.previewUrl.startsWith("/v1/")
      ? `${apiBaseUrl}${artifact.previewUrl}`
      : artifact.previewUrl;
  }

  if (workspaceId && artifact.storageKey) {
    return `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifact.id)}/file`;
  }

  return null;
}

function resolveArtifactDownloadUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;
  if (!workspaceId || !artifact.storageKey) {
    return null;
  }

  return `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

function artifactMatchesQuery(artifact: ArtifactListItem, q: string) {
  return (
    artifactTitle(artifact).toLowerCase().includes(q) ||
    artifact.artifactType.toLowerCase().includes(q) ||
    artifact.status.toLowerCase().includes(q) ||
    (artifact.promptText ?? "").toLowerCase().includes(q)
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
    storageKey: item.storageKey,
  }));
}

function getSourceParentKey(parentSourceId: string | null) {
  return parentSourceId ?? SOURCE_ROOT_PARENT_KEY;
}

function appendUniqueSources(current: SourceItem[], incoming: SourceItem[]) {
  const mergedById = new Map(current.map((source) => [source.id, source]));
  for (const source of incoming) {
    mergedById.set(source.id, source);
  }
  return Array.from(mergedById.values());
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

function TypeBadge({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-input bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
      {label}
    </span>
  );
}

export function ArtifactPreviewPanel({
  artifact,
  className,
  onClose,
  workspaceId,
}: {
  artifact: ArtifactListItem;
  className?: string;
  onClose: () => void;
  workspaceId?: string | null;
}) {
  const fileUrl = resolveArtifactFileUrl({ artifact, workspaceId });
  const downloadUrl = resolveArtifactDownloadUrl({ artifact, workspaceId });
  const title = artifactTitle(artifact);
  const canPreviewImage =
    artifact.artifactType === "image" &&
    artifact.status === "ready" &&
    Boolean(fileUrl);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [onClose]);

  const handleOpenExternal = () => {
    if (!fileUrl) {
      toast.error("This artifact has no preview file.");
      return;
    }
    window.open(fileUrl, "_blank", "noopener,noreferrer");
  };

  const handleDownload = () => {
    if (!downloadUrl) {
      toast.error("This artifact has no downloadable file.");
      return;
    }

    const link = document.createElement("a");
    link.href = downloadUrl;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col border-l bg-background text-foreground",
        className,
      )}
    >
      <div className="shrink-0 border-b bg-muted/20 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <Button
            className="gap-1.5"
            onClick={onClose}
            size="xs"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="size-3.5" />
            Artifacts
          </Button>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              disabled={!fileUrl}
              onClick={handleOpenExternal}
              size="icon-xs"
              title="Open artifact in new tab"
              type="button"
              variant="ghost"
            >
              <ExternalLink className="size-3.5" />
              <span className="sr-only">Open artifact in new tab</span>
            </Button>
            <Button
              disabled={!downloadUrl}
              onClick={handleDownload}
              size="icon-xs"
              title="Download artifact"
              type="button"
              variant="ghost"
            >
              <Download className="size-3.5" />
              <span className="sr-only">Download artifact</span>
            </Button>
          </div>
        </div>

        <div className="mt-2 min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <TypeBadge label={artifactTypeLabel(artifact.artifactType)} />
            <TypeBadge label={artifact.status} />
            <span>{new Date(artifact.createdAt).toLocaleString()}</span>
            {artifact.completedAt ? (
              <span>
                completed {new Date(artifact.completedAt).toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/10 px-3 py-3">
        {artifact.status === "pending" || artifact.status === "running" ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-background/70 px-5 text-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Artifact is still generating
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Preview will be available when the image is ready.
              </p>
            </div>
          </div>
        ) : artifact.status === "failed" ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
            <p className="text-sm font-medium text-destructive">
              Artifact generation failed
            </p>
            <p className="mt-2 text-xs leading-5 text-destructive/80">
              {artifact.errorMessage || "No error details were saved."}
            </p>
          </div>
        ) : canPreviewImage && fileUrl ? (
          <div className="flex min-h-80 items-center justify-center rounded-xl bg-background p-2">
            <GeneratedImagePreview
              className="w-full [&>span]:mx-auto [&>span]:grid [&>span]:min-h-80 [&>span]:w-full [&>span]:max-w-full [&>span]:place-items-center [&>span>img]:max-h-[calc(100vh-15rem)] [&>span>img]:max-w-full"
              downloadUrl={downloadUrl ?? fileUrl}
              imageUrl={fileUrl}
              title={title}
            />
          </div>
        ) : (
          <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-background/70 px-5 text-center">
            <div>
              <Sparkles className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                Preview is not available
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Image artifacts can be previewed here. This artifact type is kept
                compatible for future preview renderers.
              </p>
            </div>
          </div>
        )}

        {artifact.promptText ? (
          <div className="mt-3 rounded-xl border bg-background/70 p-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Prompt
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {artifact.promptText}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
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

function areStringArraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function SourceRow({
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

  function handleMenuAction(event: MouseEvent<HTMLElement>, action: () => void) {
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
              <div className="mt-0.5 flex items-center gap-1.5">
                <StatusDot status={source.status} />
                <span className="truncate text-[10px] text-muted-foreground">
                  {metaLabel}
                </span>
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
}

function sourceMatchesQuery(source: SourceItem, q: string) {
  return (
    source.title.toLowerCase().includes(q) ||
    source.type.toLowerCase().includes(q) ||
    source.status.toLowerCase().includes(q) ||
    source.meta.toLowerCase().includes(q)
  );
}

function buildSourceTreeIndex(sources: SourceItem[]): SourceTreeIndex {
  const byParent = new Map<string | null, SourceItem[]>();

  for (const source of sources) {
    const parentId = source.parentSourceId ?? null;
    const items = byParent.get(parentId) ?? [];
    items.push(source);
    byParent.set(parentId, items);
  }

  for (const items of byParent.values()) {
    items.sort((a, b) => {
      if (a.sourceType === "directory" && b.sourceType !== "directory") return -1;
      if (a.sourceType !== "directory" && b.sourceType === "directory") return 1;
      return a.title.localeCompare(b.title);
    });
  }

  return { byParent };
}

function buildSourceTreeFromIndex(
  index: SourceTreeIndex,
  searchQuery: string,
) {
  const q = searchQuery.trim().toLowerCase();

  function build(parentId: string | null, ancestorsMatch = false): SourceTreeNode[] {
    return (index.byParent.get(parentId) ?? [])
      .map((source) => {
        const selfMatch = !q || sourceMatchesQuery(source, q);
        const children = build(source.id, ancestorsMatch || selfMatch);
        if (q && !selfMatch && children.length === 0 && !ancestorsMatch) {
          return null;
        }
        return { source, children } satisfies SourceTreeNode;
      })
      .filter((node): node is SourceTreeNode => node !== null);
  }

  return build(null);
}

function buildSourceTree(sources: SourceItem[], searchQuery: string) {
  return buildSourceTreeFromIndex(buildSourceTreeIndex(sources), searchQuery);
}

function countTreeNodes(nodes: SourceTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countTreeNodes(node.children), 0);
}

function collectTreeIds(node: SourceTreeNode): string[] {
  return [
    node.source.id,
    ...node.children.flatMap((child) => collectTreeIds(child)),
  ];
}

function isSelectableSource(source: SourceItem) {
  return source.status !== "Failed" && source.status !== "Syncing";
}

function isSyncingSource(source: SourceItem) {
  return source.status === "Syncing";
}

function collectSelectableTreeIds(node: SourceTreeNode): string[] {
  return [
    ...(isSelectableSource(node.source) ? [node.source.id] : []),
    ...node.children.flatMap((child) => collectSelectableTreeIds(child)),
  ];
}

function collectSelectableSourceIds(nodes: SourceTreeNode[]) {
  return nodes.flatMap((node) => collectSelectableTreeIds(node));
}

function getNodeSelectionState(
  node: SourceTreeNode,
  selectedSet: Set<string>,
  ancestorSelected = false,
): SourceSelectionState {
  if (!isSelectableSource(node.source)) {
    return false;
  }

  if (ancestorSelected || selectedSet.has(node.source.id)) {
    return true;
  }

  if (node.children.length === 0) {
    return false;
  }

  const childStates = node.children.map((child) =>
    getNodeSelectionState(child, selectedSet),
  );
  if (childStates.every((state) => state === true)) {
    return true;
  }
  if (childStates.some((state) => state !== false)) {
    return "indeterminate";
  }
  return false;
}

function buildSourceSelectionStateMap(
  nodes: SourceTreeNode[],
  selectedSet: Set<string>,
) {
  const selectionStateById = new Map<string, SourceSelectionState>();

  function visit(
    node: SourceTreeNode,
    ancestorSelected = false,
  ): SourceSelectionState {
    const selectedByAncestorOrSelf =
      ancestorSelected || selectedSet.has(node.source.id);

    if (!isSelectableSource(node.source)) {
      selectionStateById.set(node.source.id, false);
      node.children.forEach((child) => visit(child, selectedByAncestorOrSelf));
      return false;
    }

    if (selectedByAncestorOrSelf) {
      selectionStateById.set(node.source.id, true);
      node.children.forEach((child) => visit(child, true));
      return true;
    }

    if (node.children.length === 0) {
      selectionStateById.set(node.source.id, false);
      return false;
    }

    const childStates = node.children.map((child) => visit(child, false));
    const selectionState = childStates.every((state) => state === true)
      ? true
      : childStates.some((state) => state !== false)
        ? "indeterminate"
        : false;
    selectionStateById.set(node.source.id, selectionState);
    return selectionState;
  }

  nodes.forEach((node) => visit(node));
  return selectionStateById;
}

type FlattenedSourceTreeRow = {
  node: SourceTreeNode;
  depth: number;
};

function flattenSourceTree(nodes: SourceTreeNode[]) {
  const rows: FlattenedSourceTreeRow[] = [];

  function visit(node: SourceTreeNode, depth: number) {
    rows.push({ node, depth });
    node.children.forEach((child) => visit(child, depth + 1));
  }

  nodes.forEach((node) => visit(node, 0));
  return rows;
}

function useVirtualRows(input: {
  enabled: boolean;
  rowCount: number;
  rowHeight: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    if (!input.enabled) {
      setScrollTop(0);
      return;
    }

    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight);
    };

    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [input.enabled]);

  const startIndex = input.enabled
    ? Math.max(0, Math.floor(scrollTop / input.rowHeight) - SOURCE_TREE_OVERSCAN_ROWS)
    : 0;
  const visibleCount = input.enabled
    ? Math.ceil(viewportHeight / input.rowHeight) + SOURCE_TREE_OVERSCAN_ROWS * 2
    : input.rowCount;
  const endIndex = input.enabled
    ? Math.min(input.rowCount, startIndex + visibleCount)
    : input.rowCount;

  return {
    containerRef,
    endIndex,
    onScroll: input.enabled
      ? () => {
          const element = containerRef.current;
          if (element) {
            setScrollTop(element.scrollTop);
          }
        }
      : undefined,
    startIndex,
    topPadding: input.enabled ? startIndex * input.rowHeight : 0,
    totalHeight: input.rowCount * input.rowHeight,
  };
}

function findNodePath(
  nodes: SourceTreeNode[],
  sourceId: string,
): SourceTreeNode[] | null {
  for (const node of nodes) {
    if (node.source.id === sourceId) {
      return [node];
    }

    const childPath = findNodePath(node.children, sourceId);
    if (childPath) {
      return [node, ...childPath];
    }
  }

  return null;
}

function subtreeContainsSource(node: SourceTreeNode, sourceId: string): boolean {
  return (
    node.source.id === sourceId ||
    node.children.some((child) => subtreeContainsSource(child, sourceId))
  );
}

function selectSubtreeExcept(
  node: SourceTreeNode,
  excludedNode: SourceTreeNode,
): string[] {
  if (node.source.id === excludedNode.source.id) {
    return [];
  }

  if (!isSelectableSource(node.source)) {
    return [];
  }

  const childWithExcludedNode = node.children.find((child) =>
    subtreeContainsSource(child, excludedNode.source.id),
  );
  if (!childWithExcludedNode) {
    return [node.source.id];
  }

  return node.children.flatMap((child) =>
    child.source.id === childWithExcludedNode.source.id
      ? selectSubtreeExcept(child, excludedNode)
      : collectSelectableTreeIds(child),
  );
}

function normalizeSourceSelectionFromTree(
  nodes: SourceTreeNode[],
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);

  function normalizeNode(node: SourceTreeNode): string[] {
    if (!isSelectableSource(node.source)) {
      return [];
    }

    if (selectedSet.has(node.source.id)) {
      return [node.source.id];
    }

    if (node.children.length === 0) {
      return [];
    }

    const childIds = node.children.flatMap(normalizeNode);
    const allChildrenSelected = node.children.every(
      (child) => getNodeSelectionState(child, selectedSet) === true,
    );

    if (!allChildrenSelected) {
      return childIds;
    }

    return [node.source.id];
  }

  return nodes.flatMap(normalizeNode);
}

function toggleSourceSelectionInTree(
  fullTree: SourceTreeNode[],
  node: SourceTreeNode,
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);
  if (!isSelectableSource(node.source)) {
    return selectedIds.filter((id) => id !== node.source.id);
  }

  const nodePath = findNodePath(fullTree, node.source.id) ?? [node];
  const selectedAncestor = [...nodePath]
    .slice(0, -1)
    .reverse()
    .find((ancestor) => selectedSet.has(ancestor.source.id));
  const nodeState = getNodeSelectionState(
    node,
    selectedSet,
    Boolean(selectedAncestor),
  );
  const idsToRemove = new Set(collectSelectableTreeIds(node));

  if (nodeState === true) {
    if (selectedAncestor) {
      const replacementIds = selectSubtreeExcept(selectedAncestor, node);
      return [
        ...selectedIds.filter((id) => id !== selectedAncestor.source.id),
        ...replacementIds,
      ];
    }

    return selectedIds.filter((id) => !idsToRemove.has(id));
  }

  const next = selectedIds.filter((id) => !idsToRemove.has(id));
  const selectableIds = collectSelectableTreeIds(node);
  if (selectableIds.length === 0) {
    return next;
  }
  return [...next, node.source.id];
}

function SourceTreeRow({
  node,
  depth,
  autoExpand = false,
  forceFlat = false,
  loadedSourceParentIds,
  loadingMoreSourceParentByKey,
  loadingSourceParentByKey,
  sourceParentCursorByKey,
  sourceParentErrorByKey,
  selectionStateById,
  onToggle,
  onLoadChildren,
  onLoadMoreChildren,
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
}: {
  node: SourceTreeNode;
  depth: number;
  autoExpand?: boolean;
  forceFlat?: boolean;
  loadedSourceParentIds: Set<string>;
  loadingMoreSourceParentByKey: SourceParentStatusMap;
  loadingSourceParentByKey: SourceParentStatusMap;
  sourceParentCursorByKey: SourceParentCursorMap;
  sourceParentErrorByKey: SourceParentErrorMap;
  selectionStateById: Map<string, SourceSelectionState>;
  onToggle: (node: SourceTreeNode) => void;
  onLoadChildren: (parentSourceId: string) => void;
  onLoadMoreChildren: (parentSourceId: string) => void;
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
}) {
  const [userOpen, setUserOpen] = useState(false);
  const source = node.source;
  const isDirectory = source.sourceType === "directory";
  const selectionState = selectionStateById.get(source.id) ?? false;
  const childrenParentKey = getSourceParentKey(source.id);
  const childrenLoaded = loadedSourceParentIds.has(childrenParentKey);
  const isLoadingChildren = Boolean(loadingSourceParentByKey[childrenParentKey]);
  const isLoadingMoreChildren = Boolean(
    loadingMoreSourceParentByKey[childrenParentKey],
  );
  const childrenError = sourceParentErrorByKey[childrenParentKey] ?? null;
  const hasMoreChildren = Boolean(sourceParentCursorByKey[childrenParentKey]);
  const open = autoExpand || userOpen;

  function handleDirectoryOpenChange(nextOpen: boolean) {
    setUserOpen(nextOpen);
    if (nextOpen && !childrenLoaded && !isLoadingChildren) {
      onLoadChildren(source.id);
    }
  }

  function handleFlatDirectoryLoad(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!childrenLoaded && !isLoadingChildren) {
      onLoadChildren(source.id);
    }
  }

  if (!isDirectory || forceFlat) {
    const noop = () => {};
    return (
      <SourceRow
        childCount={isDirectory ? node.children.length : undefined}
        depth={depth}
        editTitle={editingTitle}
        isBusy={Boolean(rowBusyById[source.id])}
        isEditing={editingId === source.id}
        leading={
          isDirectory ? (
            <button
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
              disabled={childrenLoaded || isLoadingChildren}
              onClick={handleFlatDirectoryLoad}
              title={childrenLoaded ? "Folder loaded" : "Load folder"}
              type="button"
            >
              {isLoadingChildren ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : childrenLoaded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          ) : undefined
        }
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
          <CollapsibleTrigger asChild>
            <button
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              type="button"
            >
              {open ? (
                isLoadingChildren ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          </CollapsibleTrigger>
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
              loadedSourceParentIds={loadedSourceParentIds}
              loadingMoreSourceParentByKey={loadingMoreSourceParentByKey}
              loadingSourceParentByKey={loadingSourceParentByKey}
              node={child}
              onCancelRename={onCancelRename}
              onAddSource={onAddSource}
              onCreateDirectory={onCreateDirectory}
              onDelete={onDelete}
              onDownload={onDownload}
              onEditReadme={onEditReadme}
              onEditTitleChange={onEditTitleChange}
              onLoadChildren={onLoadChildren}
              onLoadMoreChildren={onLoadMoreChildren}
              onMove={onMove}
              onPreview={onPreview}
              onReindex={onReindex}
              onRetry={onRetry}
              onStartRename={onStartRename}
              onSubmitRename={onSubmitRename}
              onToggle={onToggle}
              rowBusyById={rowBusyById}
              selectionStateById={selectionStateById}
              sourceParentCursorByKey={sourceParentCursorByKey}
              sourceParentErrorByKey={sourceParentErrorByKey}
            />
          ))}
          {isLoadingChildren ? (
            <div
              className="flex min-h-8 items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: `${4 + (depth + 1) * SOURCE_TREE_INDENT_PX}px` }}
            >
              <Loader2 className="size-3.5 animate-spin" />
              Loading folder...
            </div>
          ) : null}
          {childrenError ? (
            <div
              className="rounded-md border border-destructive/25 bg-destructive/5 px-2 py-2 text-xs text-destructive"
              style={{ marginLeft: `${4 + (depth + 1) * SOURCE_TREE_INDENT_PX}px` }}
            >
              <p>{childrenError}</p>
              <Button
                className="mt-2 h-7"
                onClick={() => onLoadChildren(source.id)}
                size="xs"
                type="button"
                variant="outline"
              >
                Retry
              </Button>
            </div>
          ) : null}
          {childrenLoaded && node.children.length === 0 && !childrenError ? (
            <div
              className="flex min-h-8 items-center rounded-md px-1.5 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: `${4 + (depth + 1) * SOURCE_TREE_INDENT_PX}px` }}
            >
              Empty folder
            </div>
          ) : null}
          {hasMoreChildren ? (
            <Button
              className="mt-1 w-full justify-center"
              disabled={isLoadingMoreChildren}
              onClick={() => onLoadMoreChildren(source.id)}
              size="sm"
              type="button"
              variant="outline"
            >
              {isLoadingMoreChildren ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              Load more in folder
            </Button>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function HubEmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: LucideIcon;
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

function WorkfilesTab({
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
}

function ArtifactsTab({
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
        const fileUrl = resolveArtifactFileUrl({ artifact, workspaceId });

        return (
          <button
            className="group flex w-full items-start gap-3 rounded-lg border border-border/70 bg-background p-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            key={artifact.id}
            onClick={() => onPreview(artifact)}
            title={`Preview ${artifactTitle(artifact)}`}
            type="button"
          >
            {artifact.artifactType === "image" && fileUrl ? (
              <span className="block h-14 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- Artifact thumbnails use authenticated API URLs and should not go through Next image optimization. */}
                <img
                  alt={artifactTitle(artifact)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  src={fileUrl}
                />
              </span>
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
                  <span>completed {new Date(artifact.completedAt).toLocaleString()}</span>
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
          {isLoadingMore ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function SourcesTab({
  sourceTreeIndex,
  searchQuery,
  selectedIds,
  hasMore,
  isLoadingMore,
  loadedSourceParentIds,
  loadingMoreSourceParentByKey,
  loadingSourceParentByKey,
  sourceParentCursorByKey,
  sourceParentErrorByKey,
  onLoadMore,
  onToggle,
  onLoadChildren,
  onLoadMoreChildren,
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
}: {
  sourceTreeIndex: SourceTreeIndex;
  searchQuery: string;
  selectedIds: string[];
  hasMore: boolean;
  isLoadingMore: boolean;
  loadedSourceParentIds: Set<string>;
  loadingMoreSourceParentByKey: SourceParentStatusMap;
  loadingSourceParentByKey: SourceParentStatusMap;
  sourceParentCursorByKey: SourceParentCursorMap;
  sourceParentErrorByKey: SourceParentErrorMap;
  onLoadMore: () => void;
  onToggle: (node: SourceTreeNode) => void;
  onLoadChildren: (parentSourceId: string) => void;
  onLoadMoreChildren: (parentSourceId: string) => void;
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
}) {
  const tree = useMemo(
    () => buildSourceTreeFromIndex(sourceTreeIndex, searchQuery),
    [sourceTreeIndex, searchQuery],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectionStateById = useMemo(
    () => buildSourceSelectionStateMap(tree, selectedSet),
    [selectedSet, tree],
  );
  const treeNodeCount = useMemo(() => countTreeNodes(tree), [tree]);
  const flatTreeRows = useMemo(() => flattenSourceTree(tree), [tree]);
  const shouldVirtualize = flatTreeRows.length > SOURCE_TREE_VIRTUALIZE_THRESHOLD;
  const virtualRows = useVirtualRows({
    enabled: shouldVirtualize,
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
    const virtualizedDirectoryRows = visibleFlatRows.filter(
      ({ node }) => node.source.sourceType === "directory",
    );
    const directoryWithMore = virtualizedDirectoryRows.find(({ node }) =>
      Boolean(sourceParentCursorByKey[getSourceParentKey(node.source.id)]),
    )?.node.source;
    const directoryLoadingMore = directoryWithMore
      ? Boolean(
          loadingMoreSourceParentByKey[
            getSourceParentKey(directoryWithMore.id)
          ],
        )
      : false;

    return (
      <div className="space-y-2">
        <div
          className="max-h-[min(58vh,680px)] overflow-y-auto pr-1"
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
                  loadedSourceParentIds={loadedSourceParentIds}
                  loadingMoreSourceParentByKey={loadingMoreSourceParentByKey}
                  loadingSourceParentByKey={loadingSourceParentByKey}
                  node={node}
                  onCancelRename={onCancelRename}
                  onAddSource={onAddSource}
                  onCreateDirectory={onCreateDirectory}
                  onDelete={onDelete}
                  onDownload={onDownload}
                  onEditReadme={onEditReadme}
                  onEditTitleChange={onEditTitleChange}
                  onLoadChildren={onLoadChildren}
                  onLoadMoreChildren={onLoadMoreChildren}
                  onMove={onMove}
                  onPreview={onPreview}
                  onReindex={onReindex}
                  onRetry={onRetry}
                  onStartRename={onStartRename}
                  onSubmitRename={onSubmitRename}
                  onToggle={onToggle}
                  rowBusyById={rowBusyById}
                  selectionStateById={selectionStateById}
                  sourceParentCursorByKey={sourceParentCursorByKey}
                  sourceParentErrorByKey={sourceParentErrorByKey}
                />
              ))}
            </div>
          </div>
        </div>
        {hasMore ? (
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
            Load more sources
          </Button>
        ) : null}
        {directoryWithMore ? (
          <Button
            className="w-full"
            disabled={directoryLoadingMore}
            onClick={() => onLoadMoreChildren(directoryWithMore.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            {directoryLoadingMore ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Load more in visible folder
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        {tree.map((node) => (
          <SourceTreeRow
            autoExpand={Boolean(searchQuery)}
            depth={0}
            editingId={editingId}
            editingTitle={editingTitle}
            key={node.source.id}
            loadedSourceParentIds={loadedSourceParentIds}
            loadingMoreSourceParentByKey={loadingMoreSourceParentByKey}
            loadingSourceParentByKey={loadingSourceParentByKey}
            node={node}
            onCancelRename={onCancelRename}
            onAddSource={onAddSource}
            onCreateDirectory={onCreateDirectory}
            onDelete={onDelete}
            onDownload={onDownload}
            onEditReadme={onEditReadme}
            onEditTitleChange={onEditTitleChange}
            onLoadChildren={onLoadChildren}
            onLoadMoreChildren={onLoadMoreChildren}
            onMove={onMove}
            onPreview={onPreview}
            onReindex={onReindex}
            onRetry={onRetry}
            onStartRename={onStartRename}
            onSubmitRename={onSubmitRename}
            onToggle={onToggle}
            rowBusyById={rowBusyById}
            selectionStateById={selectionStateById}
            sourceParentCursorByKey={sourceParentCursorByKey}
            sourceParentErrorByKey={sourceParentErrorByKey}
          />
        ))}
      </div>
      {hasMore ? (
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
          Load more sources
        </Button>
      ) : null}
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
            {detail?.skill.description ?? "Review this skill before selecting it."}
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
        if (source.parentSourceId && ids.has(source.parentSourceId) && !ids.has(source.id)) {
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
                  SourceWeft will fetch the page content and index it for search.
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
          <DialogDescription>Add a folder to organize Sources.</DialogDescription>
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
            <MessageResponse className="text-sm leading-7 text-foreground [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/30 [&_pre]:p-3">
              {previewWorkfile.contentText}
            </MessageResponse>
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
            Delete {deleteSource?.sourceType === "directory" ? "folder" : "source"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleteSource?.sourceType === "directory"
              ? "This will remove the folder and its sources from this workspace. This action cannot be undone."
              : "This will remove the source from this workspace. This action cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteSource ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">{deleteSource.title}</span>
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
            <span className="line-clamp-2 break-words">{deleteWorkfile.path}</span>
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
  skill,
  selected,
  disabled,
  onToggle,
  onOpenSkill,
}: {
  skill: HubSkillItem;
  selected: boolean;
  disabled?: boolean;
  onToggle: (id: string) => void;
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

    onToggle(skill.id);
  }

  return (
    <article
      className={cn(
        "group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors",
        selected ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-accent/60",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
      onClick={handleRowClick}
    >
      <Checkbox
        checked={selected}
        className="mt-0.5"
        disabled={disabled}
        onCheckedChange={() => onToggle(skill.id)}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Sparkles
            className={cn(
              "size-3 shrink-0",
              selected ? "text-primary" : "text-muted-foreground",
            )}
          />
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
        </div>
      </div>
    </article>
  );
}

function SkillsTab({
  skills,
  searchQuery,
  selectedSkillIds,
  onSkillSelectionChange,
  onOpenSkill,
  disabledToolNames = [],
}: {
  skills: HubSkillItem[];
  searchQuery: string;
  selectedSkillIds: string[];
  onSkillSelectionChange: (ids: string[]) => void;
  onOpenSkill: (catalogId: string) => void;
  disabledToolNames?: string[];
}) {
  const q = searchQuery.trim().toLowerCase();
  const selectedSet = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
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

  function toggleSkill(skillId: string) {
    const skill = skills.find((item) => item.id === skillId);
    if (skill?.tools?.some((toolName) => disabledToolSet.has(toolName))) {
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
        icon={Sparkles}
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
      {filtered.map((skill) => (
        <SkillRow
          disabled={skill.tools?.some((toolName) =>
            disabledToolSet.has(toolName),
          )}
          key={skill.id}
          onOpenSkill={onOpenSkill}
          onToggle={toggleSkill}
          selected={selectedSet.has(skill.id)}
          skill={skill}
        />
      ))}
    </div>
  );
}

function formatConnectorDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function connectorCatalogMatches(item: ConnectorCatalogItem, searchQuery: string) {
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
    connector.name,
    connector.status,
    connector.meta,
    connector.raw.connectorType,
    connector.raw.lastError ?? "",
  ].some((value) => value.toLowerCase().includes(q));
}

function statusTone(status: ConnectorCatalogStatusKind) {
  if (status === "active") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "syncing") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "connected" || status === "available") return "border-primary/30 bg-primary/10 text-primary";
  if (status === "needs_setup") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "error") return "border-destructive/30 bg-destructive/10 text-destructive";
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

function getCatalogConnector(item: ConnectorCatalogItem, connectors: ConnectorItem[]) {
  if (item.id !== "notion") return null;
  return (
    connectors.find(
      (connector) =>
        connector.raw.connectorType === "notion" &&
        connector.status !== "disabled",
    ) ?? null
  );
}

function getNotionConnectorStatus(input: {
  connector: ConnectorItem | null;
  hasActiveAccount: boolean;
  isBusy: boolean;
  webhookConfig: NotionWebhookConfig | null;
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
    if (input.webhookConfig && !input.webhookConfig.isConfigured) {
      return {
        kind: "needs_setup",
        label: "Needs setup",
        detail: "Configure a public HTTPS webhook endpoint.",
      };
    }
    return {
      kind: "active",
      label: "Active",
      detail: `Last sync ${formatConnectorDate(connector.raw.lastIndexedAt)}`,
    };
  }

  if (input.hasActiveAccount) {
    return {
      kind: "connected",
      label: "Connected",
      detail: "OAuth is connected. Enable syncing to create the connector.",
    };
  }

  return {
    kind: "available",
    label: "Available",
    detail: "Ready to connect with Notion OAuth.",
  };
}

function getCatalogStatus(input: {
  item: ConnectorCatalogItem;
  connectors: ConnectorItem[];
  hasActiveNotionAccount: boolean;
  connectorBusyById: Record<string, boolean>;
  webhookConfig: NotionWebhookConfig | null;
}): ConnectorCatalogStatus {
  if (input.item.connectMode === "coming_soon") {
    return {
      kind: "coming_soon",
      label: "Coming soon",
      detail: "This integration is on the roadmap.",
    };
  }
  const connector = getCatalogConnector(input.item, input.connectors);
  return getNotionConnectorStatus({
    connector,
    hasActiveAccount: input.hasActiveNotionAccount,
    isBusy: Boolean(connector && input.connectorBusyById[connector.id]),
    webhookConfig: input.webhookConfig,
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

function ConnectorLogo({
  icon: Icon,
  active,
  className,
}: {
  icon: LucideIcon;
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
      <Icon className="size-4" />
    </div>
  );
}

function ConnectorCatalogCard({
  item,
  status,
  connector,
  isConnectingNotion,
  onConfigure,
  onConnectNotion,
  onCreateNotionConnector,
  onRequestConnector,
}: {
  item: ConnectorCatalogItem;
  status: ConnectorCatalogStatus;
  connector: ConnectorItem | null;
  isConnectingNotion: boolean;
  onConfigure: () => void;
  onConnectNotion: () => void;
  onCreateNotionConnector: () => void;
  onRequestConnector: (item: ConnectorCatalogItem) => void;
}) {
  const isNotion = item.connectMode === "oauth_connector";
  const isBusy = isConnectingNotion && isNotion;
  const cta =
    item.connectMode === "coming_soon"
      ? "Request"
      : connector
        ? "Configure"
        : status.kind === "connected"
          ? "Enable"
          : "Connect";

  function handleAction() {
    if (item.connectMode === "coming_soon") {
      onRequestConnector(item);
      return;
    }
    if (connector) {
      onConfigure();
      return;
    }
    if (status.kind === "connected") {
      onCreateNotionConnector();
      return;
    }
    onConnectNotion();
  }

  return (
    <article
      className={cn(
        "group flex min-h-[112px] flex-col justify-between rounded-lg border bg-background p-2.5 shadow-xs transition-colors hover:bg-accent/30",
        status.kind === "needs_setup" && "border-amber-500/30",
        status.kind === "error" && "border-destructive/30",
      )}
    >
      <div className="flex items-start gap-2.5">
        <ConnectorLogo
          active={status.kind === "active" || status.kind === "connected"}
          icon={item.icon}
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
            <div className="hidden max-w-[42%] shrink-0 sm:block">
              <ConnectorStatusBadge status={status} />
            </div>
          </div>
          <div className="mt-1.5 hidden flex-wrap gap-1 sm:flex">
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
        <Button
          className="shrink-0"
          disabled={isBusy}
          onClick={handleAction}
          size="xs"
          type="button"
          variant={status.kind === "coming_soon" ? "outline" : "default"}
        >
          {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {cta}
        </Button>
      </div>
    </article>
  );
}

function ActiveConnectorCard({
  connector,
  connectorBusyById,
  webhookConfig,
  webhookEvents,
  onCopyWebhook,
  onDisconnect,
  onSyncConnector,
  onToggleStatus,
}: {
  connector: ConnectorItem;
  connectorBusyById: Record<string, boolean>;
  webhookConfig: NotionWebhookConfig | null;
  webhookEvents: ConnectorWebhookEventItem[];
  onCopyWebhook: (value: string) => void;
  onDisconnect: (connector: ConnectorItem) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleStatus: (connector: ConnectorItem) => void;
}) {
  const isBusy = Boolean(connectorBusyById[connector.id]);
  const catalogItem =
    connectorCatalog.find((item) => item.id === connector.raw.connectorType) ??
    connectorCatalog.find((item) => item.id === "notion");
  const icon = catalogItem?.icon ?? Link2;
  const status = getNotionConnectorStatus({
    connector,
    hasActiveAccount: true,
    isBusy,
    webhookConfig:
      connector.raw.connectorType === "notion" ? webhookConfig : null,
  });
  const pauseLabel = connector.status === "paused" ? "Resume" : "Pause";
  const PauseIcon = connector.status === "paused" ? Play : PowerOff;

  return (
    <article className="rounded-lg border bg-background p-2.5 shadow-xs">
      <div className="flex items-start gap-2.5">
        <ConnectorLogo active icon={icon} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="truncate text-sm font-medium text-foreground">
                {connector.name}
              </h4>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {connector.raw.connectorType} · {connector.meta}
              </p>
            </div>
            <div className="hidden shrink-0 sm:block">
              <ConnectorStatusBadge status={status} />
            </div>
          </div>
          {connector.raw.lastError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>{connector.raw.lastError}</AlertDescription>
            </Alert>
          ) : null}
          {connector.raw.connectorType === "notion" && webhookConfig ? (
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
                Add this URL in Notion connection settings after OAuth is
                complete. Notion requires public HTTPS.
              </p>
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
          disabled={connector.status !== "active" || isBusy}
          onClick={() => onSyncConnector(connector)}
          size="xs"
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
          disabled={isBusy}
          onClick={() => onToggleStatus(connector)}
          size="xs"
          type="button"
          variant="outline"
        >
          <PauseIcon className="size-3.5" />
          {pauseLabel}
        </Button>
        <Button
          disabled={isBusy}
          onClick={() => onDisconnect(connector)}
          size="xs"
          type="button"
          variant="ghost"
        >
          <Power className="size-3.5" />
          Disconnect
        </Button>
      </div>
    </article>
  );
}

function ManageConnectorsDialog({
  accounts,
  connectorBusyById,
  connectors,
  isConnectingNotion,
  isLoading,
  loadingError,
  onConnectNotion,
  onCopyWebhook,
  onCreateNotionConnector,
  onDisconnectConnector,
  onOpenChange,
  onRequestConnector,
  onSyncConnector,
  onToggleConnectorStatus,
  open,
  webhookConfig,
  webhookEvents,
}: {
  accounts: ConnectorAccountItem[];
  connectorBusyById: Record<string, boolean>;
  connectors: ConnectorItem[];
  isConnectingNotion: boolean;
  isLoading: boolean;
  loadingError: string | null;
  onConnectNotion: () => void;
  onCopyWebhook: (value: string) => void;
  onCreateNotionConnector: () => void;
  onDisconnectConnector: (connector: ConnectorItem) => void;
  onOpenChange: (open: boolean) => void;
  onRequestConnector: (item: ConnectorCatalogItem) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleConnectorStatus: (connector: ConnectorItem) => void;
  open: boolean;
  webhookConfig: NotionWebhookConfig | null;
  webhookEvents: ConnectorWebhookEventItem[];
}) {
  const [tab, setTab] = useState<ManageConnectorsTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const activeConnectors = connectors.filter(
    (connector) => connector.status !== "disabled",
  );
  const hasActiveNotionAccount = accounts.some(
    (account) =>
      account.connectorType === "notion" && account.status === "active",
  );
  const visibleCatalog = connectorCatalog.filter((item) =>
    connectorCatalogMatches(item, searchQuery),
  );
  const visibleActiveConnectors = activeConnectors.filter((connector) =>
    connectorMatchesSearch(connector, searchQuery),
  );
  const filterLabel = tab === "active" ? "Active only" : "All connectors";

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
                      className={cn(
                        "size-3.5",
                        tab !== "all" && "opacity-0",
                      )}
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
                    Active only
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
                              hasActiveNotionAccount,
                              connectorBusyById,
                              webhookConfig,
                            });
                            return (
                              <ConnectorCatalogCard
                                connector={connector}
                                isConnectingNotion={isConnectingNotion}
                                item={item}
                                key={item.id}
                                onConfigure={() => setTab("active")}
                                onConnectNotion={onConnectNotion}
                                onCreateNotionConnector={
                                  onCreateNotionConnector
                                }
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
                  {visibleActiveConnectors.length > 0 ? (
                    visibleActiveConnectors.map((connector) => (
                      <ActiveConnectorCard
                        connector={connector}
                        connectorBusyById={connectorBusyById}
                        key={connector.id}
                        onCopyWebhook={onCopyWebhook}
                        onDisconnect={onDisconnectConnector}
                        onSyncConnector={onSyncConnector}
                        onToggleStatus={onToggleConnectorStatus}
                        webhookConfig={webhookConfig}
                        webhookEvents={webhookEvents}
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
                          ? `No active connectors match "${searchQuery}"`
                          : "No active connectors yet."
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
  isLoading,
  loadingError,
  onManageConnectors,
  webhookConfig,
}: {
  connectors: ConnectorItem[];
  isLoading: boolean;
  loadingError: string | null;
  onManageConnectors: () => void;
  webhookConfig: NotionWebhookConfig | null;
}) {
  const activeConnectors = connectors.filter(
    (connector) => connector.status !== "disabled",
  );
  const errorConnectors = activeConnectors.filter(
    (connector) => connector.status === "error" || connector.raw.lastError,
  );
  const needsWebhookSetup =
    activeConnectors.some((connector) => connector.raw.connectorType === "notion") &&
    webhookConfig &&
    !webhookConfig.isConfigured;
  const recentConnector = activeConnectors[0] ?? null;

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

      <div className="rounded-lg border bg-muted/25 p-3">
        <div className="flex items-start gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <Link2 className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              Connector catalog
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Connect Notion or preview upcoming integrations for your
              workspace.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <TypeBadge label={`${activeConnectors.length} active`} />
              <TypeBadge label={`${connectorCatalog.length} available`} />
              {errorConnectors.length > 0 ? (
                <TypeBadge label={`${errorConnectors.length} error`} />
              ) : null}
              {needsWebhookSetup ? <TypeBadge label="Webhook setup" /> : null}
            </div>
          </div>
        </div>
      </div>

      {recentConnector ? (
        <div className="rounded-lg border bg-background p-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-foreground">
              {recentConnector.name}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {recentConnector.status}
            </span>
          </div>
          <p className="mt-1 truncate text-muted-foreground">
            {recentConnector.meta}
          </p>
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
          {([
            ["current", `Current (${currentCitationItems.length})`],
            ["thread", `Thread (${threadCitationItems.length})`],
          ] as const).map(([scope, label]) => (
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
                  canLocate && "cursor-pointer hover:border-primary/30 hover:bg-primary/5",
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
  return items.filter((citation) =>
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

function countFilteredSkills(items: HubSkillItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items.length;
  }
  return items.filter((skill) =>
    skill.displayName.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q) ||
    skill.name.toLowerCase().includes(q) ||
    skill.slug.toLowerCase().includes(q) ||
    skillSourceLabel(skill.sourceType).toLowerCase().includes(q),
  ).length;
}

function mapConnectorToUi(connector: SourceConnector): ConnectorItem {
  const lastSync = connector.lastIndexedAt
    ? `Last sync ${new Date(connector.lastIndexedAt).toLocaleString()}`
    : "Not synced yet";
  const schedule = connector.periodicIndexingEnabled
    ? `Every ${connector.indexingFrequencyMinutes ?? "?"} min`
    : "Manual sync";
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
  onArtifactOpen,
  onSkillsCatalogChange,
  installedSkills = [],
  selectedSkillIds = [],
  onSkillSelectionChange = () => {},
  disabledToolNames = [],
  onClose,
  variant = "panel",
}: {
  activeCitationIndex?: number | null;
  citations?: CitationRecord[];
  currentCitationMessageId?: string | null;
  mode: "thread" | "new";
  onCitationOpen?: (citation: CitationRecord, context?: CitationOpenContext) => void;
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
  onArtifactOpen?: (artifact: ArtifactListItem) => void;
  onSkillsCatalogChange?: () => void | Promise<void>;
  installedSkills?: HubSkillItem[];
  selectedSkillIds?: string[];
  onSkillSelectionChange?: (ids: string[]) => void;
  disabledToolNames?: string[];
  onClose?: () => void;
  variant?: "panel" | "drawer";
}) {
  const [activeTab, setActiveTab] = useState<HubTab>(lastHubActiveTab);
  const [citationScope, setCitationScope] = useState<CitationScope>("current");
  const [searchQueries, setSearchQueries] = useState<Record<HubTab, string>>({
    Sources: "",
    Workfiles: "",
    Artifacts: "",
    Skills: "",
    Citations: "",
    Connectors: "",
  });
  const searchQuery = searchQueries[activeTab];
  const deferredSearchQueries = useDeferredValue(searchQueries);
  const deferredSearchQuery = deferredSearchQueries[activeTab];
  const [sources, setSources] = useState<SourceItem[]>(initialSources);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMoreSources, setIsLoadingMoreSources] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [sourceParentCursorByKey, setSourceParentCursorByKey] =
    useState<SourceParentCursorMap>({});
  const [loadedSourceParentIds, setLoadedSourceParentIds] = useState<Set<string>>(
    () => new Set(initialSourcesLoaded ? [SOURCE_ROOT_PARENT_KEY] : []),
  );
  const [loadingSourceParentByKey, setLoadingSourceParentByKey] =
    useState<SourceParentStatusMap>({});
  const [loadingMoreSourceParentByKey, setLoadingMoreSourceParentByKey] =
    useState<SourceParentStatusMap>({});
  const [sourceParentErrorByKey, setSourceParentErrorByKey] =
    useState<SourceParentErrorMap>({});
  const [workfiles, setWorkfiles] = useState<WorkfileListItem[]>([]);
  const [isLoadingWorkfiles, setIsLoadingWorkfiles] = useState(false);
  const [workfilesLoadingError, setWorkfilesLoadingError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactListItem[]>([]);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [isLoadingMoreArtifacts, setIsLoadingMoreArtifacts] = useState(false);
  const [artifactsLoadingError, setArtifactsLoadingError] = useState<string | null>(null);
  const [artifactsNextCursor, setArtifactsNextCursor] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [connectorAccounts, setConnectorAccounts] = useState<
    ConnectorAccountItem[]
  >([]);
  const [isLoadingConnectors, setIsLoadingConnectors] = useState(false);
  const [connectorsLoadingError, setConnectorsLoadingError] = useState<string | null>(null);
  const [connectorBusyById, setConnectorBusyById] = useState<Record<string, boolean>>({});
  const [isConnectingNotion, setIsConnectingNotion] = useState(false);
  const [isManageConnectorsOpen, setIsManageConnectorsOpen] = useState(false);
  const [pendingDisconnectConnector, setPendingDisconnectConnector] =
    useState<ConnectorItem | null>(null);
  const [connectorWebhookEvents, setConnectorWebhookEvents] = useState<
    ConnectorWebhookEventItem[]
  >([]);
  const [notionWebhookConfig, setNotionWebhookConfig] =
    useState<NotionWebhookConfig | null>(null);
  const [previewWorkfile, setPreviewWorkfile] = useState<WorkfileDetail | null>(null);
  const [deleteWorkfile, setDeleteWorkfile] = useState<WorkfileListItem | null>(null);
  const [workfileBusyByPath, setWorkfileBusyByPath] = useState<Record<string, boolean>>({});
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
    () => countFilteredSkills(installedSkills, deferredSearchQueries.Skills),
    [deferredSearchQueries.Skills, installedSkills],
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
  const activeCitationChunkId = activeCitationIndex
    ? (citations[activeCitationIndex - 1]?.chunkId ?? null)
    : null;
  const addSourceDialog = useAddSourceDialogState();
  const resetAddSourceDialog = addSourceDialog.reset;
  const [isCreateDirectoryOpen, setIsCreateDirectoryOpen] = useState(false);
  const [directoryTitle, setDirectoryTitle] = useState("");
  const [directoryContext, setDirectoryContext] = useState("");
  const [directoryParentSourceId, setDirectoryParentSourceId] = useState<string | null>(null);
  const [readmeSource, setReadmeSource] = useState<SourceItem | null>(null);
  const [readmeContent, setReadmeContent] = useState("");
  const [moveSource, setMoveSource] = useState<SourceItem | null>(null);
  const [moveParentSourceId, setMoveParentSourceId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const currentWorkspaceIdRef = useRef<string | null | undefined>(workspaceId);
  const loadedSourcesWorkspaceIdRef = useRef<string | null>(null);
  const initializedSourcesWorkspaceIdRef = useRef<string | null>(null);
  const sourceParentCursorRef = useRef<SourceParentCursorMap>({});
  const loadedSourceParentIdsRef = useRef<Set<string>>(
    new Set(initialSourcesLoaded ? [SOURCE_ROOT_PARENT_KEY] : []),
  );
  const loadingSourceParentKeysRef = useRef<Set<string>>(new Set());
  const loadingMoreSourceParentKeysRef = useRef<Set<string>>(new Set());

  const [pendingSourceIds, setPendingSourceIds] = useState<string[]>([]);

  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [rowBusyById, setRowBusyById] = useState<Record<string, boolean>>({});
  const [previewSource, setPreviewSource] = useState<SourceItem | null>(null);
  const [previewSkillCatalogId, setPreviewSkillCatalogId] = useState<string | null>(null);
  const [isSkillsGalleryOpen, setIsSkillsGalleryOpen] = useState(false);
  const [deleteSource, setDeleteSource] = useState<SourceItem | null>(null);
  const sourceTreeIndex = useMemo(() => buildSourceTreeIndex(sources), [sources]);
  const fullSourceTree = useMemo(
    () => buildSourceTreeFromIndex(sourceTreeIndex, ""),
    [sourceTreeIndex],
  );
  const selectableSourceIds = useMemo(
    () => collectSelectableSourceIds(fullSourceTree),
    [fullSourceTree],
  );
  const selectedLibrarySources = useMemo(
    () => expandSelectedSources(sources, selectedIds),
    [selectedIds, sources],
  );
  const allSelectableSourcesSelected =
    selectableSourceIds.length > 0 &&
    selectedLibrarySources.length >= selectableSourceIds.length;
  const activeNotionAccount = connectorAccounts.find(
    (account) =>
      account.connectorType === "notion" && account.status === "active",
  );

  const resetSourcePagingState = useCallback(() => {
    sourceParentCursorRef.current = {};
    loadedSourceParentIdsRef.current = new Set();
    loadingSourceParentKeysRef.current = new Set();
    loadingMoreSourceParentKeysRef.current = new Set();
    setSourceParentCursorByKey({});
    setLoadedSourceParentIds(new Set());
    setLoadingSourceParentByKey({});
    setLoadingMoreSourceParentByKey({});
    setSourceParentErrorByKey({});
    setIsLoadingMoreSources(false);
  }, []);

  const replaceRootSources = useCallback(
    (items: SourceItem[], nextCursor: string | null) => {
      const nextCursorByKey = {
        [SOURCE_ROOT_PARENT_KEY]: nextCursor,
      };
      const nextLoadedParents = new Set([SOURCE_ROOT_PARENT_KEY]);

      sourceParentCursorRef.current = nextCursorByKey;
      loadedSourceParentIdsRef.current = nextLoadedParents;
      setSourceParentCursorByKey(nextCursorByKey);
      setLoadedSourceParentIds(nextLoadedParents);
      setSourceParentErrorByKey({});
      setSources(items);
    },
    [],
  );

  const appendSourcesForParent = useCallback(
    (
      parentSourceId: string | null,
      items: SourceItem[],
      nextCursor: string | null,
    ) => {
      const parentKey = getSourceParentKey(parentSourceId);
      const nextCursorByKey = {
        ...sourceParentCursorRef.current,
        [parentKey]: nextCursor,
      };
      const nextLoadedParents = new Set(loadedSourceParentIdsRef.current);
      nextLoadedParents.add(parentKey);

      sourceParentCursorRef.current = nextCursorByKey;
      loadedSourceParentIdsRef.current = nextLoadedParents;
      setSourceParentCursorByKey(nextCursorByKey);
      setLoadedSourceParentIds(nextLoadedParents);
      setSourceParentErrorByKey((current) => {
        if (!current[parentKey]) return current;
        const next = { ...current };
        delete next[parentKey];
        return next;
      });
    },
    [],
  );

  function setActiveSearchQuery(value: string) {
    setSearchQueries((current) => ({
      ...current,
      [activeTab]: value,
    }));
  }

  function handleActiveTabChange(tab: HubTab) {
    setActiveTab(tab);
    persistHubTab(tab);
  }

  useEffect(() => {
    const storedTab = readStoredHubTab();
    if (storedTab) {
      lastHubActiveTab = storedTab;
      setActiveTab(storedTab);
    }
  }, []);

  useEffect(() => {
    setCitationScope("current");
  }, [mode]);

  useEffect(() => {
    currentWorkspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  const refreshSources = useCallback(async () => {
    if (!workspaceId) {
      setSources([]);
      onSourceLoad?.([]);
      loadedSourcesWorkspaceIdRef.current = null;
      resetSourcePagingState();
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoading(true);
    setLoadingError(null);
    resetSourcePagingState();
    setSources([]);
    try {
      const result = await contentClient.listSources(activeWorkspaceId, {
        includeContent: false,
        limit: SOURCES_PAGE_SIZE,
        parentSourceId: null,
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      const mapped = mapSourcesToUi(result.items);
      replaceRootSources(mapped, result.nextCursor ?? null);
      loadedSourcesWorkspaceIdRef.current = activeWorkspaceId;
      onSourceLoad?.(mapped);
      onSourceMerge?.(mapped);

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
      resetSourcePagingState();
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoading(false);
      }
    }
  }, [
    onSourceLoad,
    onSourceMerge,
    replaceRootSources,
    resetSourcePagingState,
    workspaceId,
  ]);

  const loadMoreSources = useCallback(async (parentSourceId: string | null = null) => {
    if (!workspaceId) {
      return;
    }

    const parentKey = getSourceParentKey(parentSourceId);
    const nextCursor = sourceParentCursorRef.current[parentKey];
    if (!nextCursor) {
      return;
    }

    const isRoot = parentKey === SOURCE_ROOT_PARENT_KEY;
    if (loadingMoreSourceParentKeysRef.current.has(parentKey)) {
      return;
    }

    const activeWorkspaceId = workspaceId;
    loadingMoreSourceParentKeysRef.current.add(parentKey);
    if (isRoot) {
      setIsLoadingMoreSources(true);
      setLoadingError(null);
    } else {
      setLoadingMoreSourceParentByKey((current) => ({
        ...current,
        [parentKey]: true,
      }));
    }
    try {
      const result = await contentClient.listSources(activeWorkspaceId, {
        includeContent: false,
        cursor: nextCursor,
        limit: SOURCES_PAGE_SIZE,
        parentSourceId,
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      const mapped = mapSourcesToUi(result.items);
      appendSourcesForParent(parentSourceId, mapped, result.nextCursor ?? null);
      setSources((current) => {
        const merged = appendUniqueSources(current, mapped);
        if (parentSourceId && selectedIds.includes(parentSourceId)) {
          onSelectionChange(
            normalizeSourceSelectionFromTree(
              buildSourceTree(merged, ""),
              Array.from(
                new Set([
                  ...selectedIds,
                  ...mapped
                    .filter(isSelectableSource)
                    .map((source) => source.id),
                ]),
              ),
            ),
          );
        }
        onSourceLoad?.(merged);
        return merged;
      });
      onSourceMerge?.(mapped);

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
      setSourceParentErrorByKey((current) => {
        if (!current[parentKey]) return current;
        const next = { ...current };
        delete next[parentKey];
        return next;
      });
    } catch (error) {
      const message = getErrorMessage(error, "Failed to load more sources.");
      if (isRoot) {
        setLoadingError(message);
      } else {
        setSourceParentErrorByKey((current) => ({
          ...current,
          [parentKey]: message,
        }));
      }
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        loadingMoreSourceParentKeysRef.current.delete(parentKey);
        if (isRoot) {
          setIsLoadingMoreSources(false);
        } else {
          setLoadingMoreSourceParentByKey((current) => {
            const next = { ...current };
            delete next[parentKey];
            return next;
          });
        }
      }
    }
  }, [
    appendSourcesForParent,
    onSelectionChange,
    onSourceLoad,
    onSourceMerge,
    selectedIds,
    workspaceId,
  ]);

  const loadSourceChildren = useCallback(async (parentSourceId: string) => {
    if (!workspaceId) {
      return;
    }

    const parentKey = getSourceParentKey(parentSourceId);
    if (
      loadedSourceParentIdsRef.current.has(parentKey) ||
      loadingSourceParentKeysRef.current.has(parentKey)
    ) {
      return;
    }

    const activeWorkspaceId = workspaceId;
    loadingSourceParentKeysRef.current.add(parentKey);
    setLoadingSourceParentByKey((current) => ({
      ...current,
      [parentKey]: true,
    }));
    setSourceParentErrorByKey((current) => {
      if (!current[parentKey]) return current;
      const next = { ...current };
      delete next[parentKey];
      return next;
    });

    try {
      const result = await contentClient.listSources(activeWorkspaceId, {
        includeContent: false,
        limit: SOURCES_PAGE_SIZE,
        parentSourceId,
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      const mapped = mapSourcesToUi(result.items);
      appendSourcesForParent(parentSourceId, mapped, result.nextCursor ?? null);
      setSources((current) => {
        const merged = appendUniqueSources(current, mapped);
        onSourceLoad?.(merged);
        return merged;
      });
      onSourceMerge?.(mapped);

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
      setSourceParentErrorByKey((current) => ({
        ...current,
        [parentKey]: getErrorMessage(error, "Failed to load folder."),
      }));
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        loadingSourceParentKeysRef.current.delete(parentKey);
        setLoadingSourceParentByKey((current) => {
          const next = { ...current };
          delete next[parentKey];
          return next;
        });
      }
    }
  }, [
    appendSourcesForParent,
    onSourceLoad,
    onSourceMerge,
    workspaceId,
  ]);

  const handleLoadMoreRootSources = useCallback(() => {
    void loadMoreSources();
  }, [loadMoreSources]);

  const handleLoadMoreSourceChildren = useCallback(
    (parentSourceId: string) => {
      void loadMoreSources(parentSourceId);
    },
    [loadMoreSources],
  );

  const handleLoadSourceChildren = useCallback(
    (parentSourceId: string) => {
      void loadSourceChildren(parentSourceId);
    },
    [loadSourceChildren],
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
      const result = await contentClient.listWorkingFiles(workspaceId, threadId);
      setWorkfiles(result.items);
      threadWorkfilesCache.set(
        getThreadWorkfilesCacheKey(workspaceId, threadId),
        cloneWorkfileItems(result.items),
      );
    } catch (error) {
      setWorkfiles([]);
      setWorkfilesLoadingError(getErrorMessage(error, "Failed to load workfiles."));
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
    } catch (error) {
      setArtifacts([]);
      setArtifactsNextCursor(null);
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
        const mergedById = new Map(current.map((artifact) => [artifact.id, artifact]));
        for (const artifact of result.items) {
          mergedById.set(artifact.id, artifact);
        }
        const merged = Array.from(mergedById.values());
        workspaceArtifactsCache.set(activeWorkspaceId, cloneArtifactItems(merged));
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
      setConnectorWebhookEvents([]);
      setNotionWebhookConfig(null);
      setConnectorsLoadingError(null);
      return;
    }

    setIsLoadingConnectors(true);
    setConnectorsLoadingError(null);
    try {
      const [result, accounts] = await Promise.all([
        connectorsClient.list(workspaceId),
        connectorsClient.listAccounts(workspaceId),
      ]);
      const uiConnectors = result.items.map(mapConnectorToUi);
      const notionConnector =
        uiConnectors.find(
          (connector) =>
            connector.raw.connectorType === "notion" &&
            connector.status !== "disabled",
        ) ?? null;

      setConnectors(uiConnectors);
      setConnectorAccounts(accounts.items);
      if (!notionConnector) {
        setConnectorWebhookEvents([]);
        setNotionWebhookConfig(null);
        return;
      }

      const [webhookConfig, webhookEvents] = await Promise.allSettled([
        connectorsClient.getNotionWebhookConfig(workspaceId, notionConnector.id),
        connectorsClient.listWebhookEvents(workspaceId, {
          connectorType: "notion",
          connectorId: notionConnector.id,
        }),
      ]);
      setNotionWebhookConfig(
        webhookConfig.status === "fulfilled" ? webhookConfig.value : null,
      );
      setConnectorWebhookEvents(
        webhookEvents.status === "fulfilled" ? webhookEvents.value.items : [],
      );
    } catch (error) {
      setConnectors([]);
      setConnectorAccounts([]);
      setConnectorWebhookEvents([]);
      setNotionWebhookConfig(null);
      setConnectorsLoadingError(
        getErrorMessage(error, "Failed to load connectors."),
      );
    } finally {
      setIsLoadingConnectors(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      loadedSourcesWorkspaceIdRef.current = null;
      initializedSourcesWorkspaceIdRef.current = null;
      setSources([]);
      setLoadingError(null);
      setIsLoading(false);
      resetSourcePagingState();
      setPendingSourceIds([]);
      return;
    }

    if (initializedSourcesWorkspaceIdRef.current === workspaceId) {
      return;
    }
    initializedSourcesWorkspaceIdRef.current = workspaceId;

    setLoadingError(null);
    setPendingSourceIds([]);
    resetSourcePagingState();
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

      if (initialSourcesLoaded) {
        replaceRootSources(initialSources, null);
      } else {
        setSources([]);
      }
      void refreshSources();
  }, [
    workspaceId,
    initialSources,
    initialSourcesLoaded,
    replaceRootSources,
    refreshSources,
    resetSourcePagingState,
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

    if (workspaceArtifactsCache.has(workspaceId)) {
      const cached = workspaceArtifactsCache.get(workspaceId) ?? [];
      setArtifacts(cloneArtifactItems(cached));
      setArtifactsNextCursor(
        workspaceArtifactsCursorCache.get(workspaceId) ?? null,
      );
      setArtifactsLoadingError(null);
      setIsLoadingArtifacts(false);
      setIsLoadingMoreArtifacts(false);
      return;
    }

    void refreshArtifacts();
  }, [refreshArtifacts, workspaceId]);

  useEffect(() => {
    void refreshConnectors();
  }, [refreshConnectors]);

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
    const syncingIds = sources.filter(isSyncingSource).map((source) => source.id);
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
    Sources: selectedLibrarySources.length,
    Workfiles: workfiles.length,
    Artifacts: artifacts.length,
    Skills: selectedSkillIds.length,
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

  const handleConnectNotion = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }

    setIsConnectingNotion(true);
    try {
      const result = await connectorsClient.startOAuth(workspaceId, "notion", {
        redirectAfter: window.location.href,
      });
      window.location.href = result.authorizationUrl;
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to start Notion connection."));
    } finally {
      setIsConnectingNotion(false);
    }
  }, [workspaceId]);

  const ensureNotionConnector = useCallback(
    async (accountId?: string | null) => {
      if (!workspaceId) {
        return null;
      }
      const current = connectors.find(
        (connector) =>
          connector.raw.connectorType === "notion" &&
          connector.status !== "disabled",
      );
      if (current) {
        return current;
      }

      setIsConnectingNotion(true);
      try {
        const accounts = await connectorsClient.listAccounts(workspaceId, {
          connectorType: "notion",
        });
        const account =
          accounts.items.find((item) => item.id === accountId) ??
          accounts.items.find((item) => item.status === "active");
        if (!account) {
          toast.error("Connect Notion before creating a connector.");
          return null;
        }

        const created = await connectorsClient.create(workspaceId, {
          connectorType: "notion",
          name: account.displayName || "Notion",
          oauthAccountId: account.id,
          configJson: {
            includePages: true,
            includeDataSources: true,
            includeDatabases: true,
          },
          periodicIndexingEnabled: true,
          indexingFrequencyMinutes: 360,
        });
        toast.success("Notion connector enabled.");
        await refreshConnectors();
        return mapConnectorToUi(created.connector);
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to enable Notion connector."));
        return null;
      } finally {
        setIsConnectingNotion(false);
      }
    },
    [connectors, refreshConnectors, workspaceId],
  );

  const handleCreateNotionConnector = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    await ensureNotionConnector(activeNotionAccount?.id);
    setIsManageConnectorsOpen(true);
  }, [activeNotionAccount?.id, ensureNotionConnector, workspaceId]);

  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    if (
      url.searchParams.get("connector_oauth") !== "success" ||
      url.searchParams.get("connector_type") !== "notion"
    ) {
      return;
    }

    const accountId = url.searchParams.get("account_id");
    url.searchParams.delete("connector_oauth");
    url.searchParams.delete("connector_type");
    url.searchParams.delete("account_id");
    window.history.replaceState(null, "", url.toString());

    setIsManageConnectorsOpen(true);
    void ensureNotionConnector(accountId);
  }, [ensureNotionConnector, workspaceId]);

  const handleRequestConnector = useCallback((item: ConnectorCatalogItem) => {
    toast.info(`${item.name} is on the roadmap.`);
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
      try {
        await connectorsClient.sync(workspaceId, connector.id);
        toast.success("Connector sync queued.");
        await refreshConnectors();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to sync connector."));
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [refreshConnectors, workspaceId],
  );

  const handleToggleConnectorStatus = useCallback(
    async (connector: ConnectorItem) => {
      if (!workspaceId) return;
      const nextStatus = connector.status === "paused" ? "active" : "paused";
      setConnectorBusy(connector.id, true);
      try {
        await connectorsClient.update(workspaceId, connector.id, {
          status: nextStatus,
        });
        toast.success(
          nextStatus === "active"
            ? "Connector resumed."
            : "Connector paused.",
        );
        await refreshConnectors();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to update connector."));
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [refreshConnectors, workspaceId],
  );

  const handleConfirmDisconnectConnector = useCallback(async () => {
    if (!workspaceId || !pendingDisconnectConnector) return;
    const connector = pendingDisconnectConnector;
    setConnectorBusy(connector.id, true);
    try {
      await connectorsClient.update(workspaceId, connector.id, {
        status: "disabled",
      });
      toast.success("Connector disconnected.");
      setPendingDisconnectConnector(null);
      await refreshConnectors();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to disconnect connector."));
    } finally {
      setConnectorBusy(connector.id, false);
    }
  }, [pendingDisconnectConnector, refreshConnectors, workspaceId]);

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
    [workspaceId, fullSourceTree, refreshSources, onSelectionChange, selectedIds],
  );

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

  const handlePreviewArtifact = useCallback((artifact: ArtifactListItem) => {
    onArtifactOpen?.(artifact);
  }, [onArtifactOpen]);

  const handleOpenReadmeDialog = useCallback(async (source: SourceItem) => {
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
  }, [workspaceId]);

  const handleOpenCreateDirectory = useCallback((parentSourceId: string | null = null) => {
    setDirectoryParentSourceId(parentSourceId);
    setDirectoryTitle("");
    setDirectoryContext("");
    setIsCreateDirectoryOpen(true);
  }, []);

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
          prev.includes(created.source.id) ? prev : [...prev, created.source.id],
        );
      }
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
  }, [workspaceId, directoryTitle, directoryContext, directoryParentSourceId, refreshSources]);

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
  }, [deleteWorkfile, previewWorkfile?.path, refreshWorkfiles, threadId, workspaceId]);

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

      toast.success("Source added and indexing started.");
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create source."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources]);

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

      toast.success("URL source added. Processing started.");
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to add URL source."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources]);

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
        addSourceDialog.setUploadProgress(Math.round((processed / total) * 100));
      }

      if (createdSourceIds.length > 0) {
        setPendingSourceIds((prev) =>
          Array.from(new Set([...prev, ...createdSourceIds])),
        );
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
  }, [workspaceId, addSourceDialog, refreshSources]);

  return (
    <>
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col overflow-x-hidden bg-background",
          variant === "drawer"
            ? "w-full min-w-0"
            : "w-[410px] border-l",
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

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
          {activeTab === "Sources" && (
            <section className="space-y-1">
              <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Sources
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {sources.length} sources
                  </span>
                  {deferredSearchQueries.Sources ? (
                    <span className="text-[10px] text-primary">
                      {filteredSourceCount} found
                    </span>
                  ) : null}
                  {selectedLibrarySources.length > 0 ? (
                    <span className="text-[10px] text-primary">
                      {selectedLibrarySources.length} selected
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
                <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Loading sources...
                </div>
              ) : (
                <SourcesTab
                  editingId={editingSourceId}
                  editingTitle={editingTitle}
                  hasMore={Boolean(
                    sourceParentCursorByKey[SOURCE_ROOT_PARENT_KEY],
                  )}
                  isLoadingMore={isLoadingMoreSources}
                  loadedSourceParentIds={loadedSourceParentIds}
                  loadingMoreSourceParentByKey={loadingMoreSourceParentByKey}
                  loadingSourceParentByKey={loadingSourceParentByKey}
                  onCancelRename={handleCancelRename}
                  onDelete={handleRequestDeleteSource}
                  onDownload={handleDownloadSource}
                  onEditReadme={handleOpenReadmeDialog}
                  onEditTitleChange={setEditingTitle}
                  onAddSource={addSourceDialog.open}
                  onCreateDirectory={handleOpenCreateDirectory}
                  onLoadChildren={handleLoadSourceChildren}
                  onLoadMore={handleLoadMoreRootSources}
                  onLoadMoreChildren={handleLoadMoreSourceChildren}
                  onMove={handleOpenMoveDialog}
                  onPreview={handlePreviewSource}
                  onReindex={handleReindexSource}
                  onRetry={handleRetrySource}
                  onStartRename={handleStartRename}
                  onSubmitRename={handleSubmitRename}
                  onToggle={handleToggle}
                  rowBusyById={rowBusyById}
                  searchQuery={deferredSearchQuery}
                  selectedIds={selectedIds}
                  sourceParentCursorByKey={sourceParentCursorByKey}
                  sourceParentErrorByKey={sourceParentErrorByKey}
                  sourceTreeIndex={sourceTreeIndex}
                />
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
                    {installedSkills.length} installed
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
                  <Sparkles className="size-3.5" />
                  Skills gallery
                </Button>
              </div>

              <SkillsTab
                disabledToolNames={disabledToolNames}
                onOpenSkill={setPreviewSkillCatalogId}
                onSkillSelectionChange={onSkillSelectionChange}
                searchQuery={deferredSearchQuery}
                selectedSkillIds={selectedSkillIds}
                skills={installedSkills}
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
              connectors={connectors}
              isLoading={isLoadingConnectors}
              loadingError={connectorsLoadingError}
              onManageConnectors={() => setIsManageConnectorsOpen(true)}
              webhookConfig={notionWebhookConfig}
            />
          )}
        </div>
      </aside>

      <ManageConnectorsDialog
        accounts={connectorAccounts}
        connectorBusyById={connectorBusyById}
        connectors={connectors}
        isConnectingNotion={isConnectingNotion}
        isLoading={isLoadingConnectors}
        loadingError={connectorsLoadingError}
        onConnectNotion={() => void handleConnectNotion()}
        onCopyWebhook={handleCopyWebhook}
        onCreateNotionConnector={() => void handleCreateNotionConnector()}
        onDisconnectConnector={setPendingDisconnectConnector}
        onOpenChange={setIsManageConnectorsOpen}
        onRequestConnector={handleRequestConnector}
        onSyncConnector={(connector) => void handleSyncConnector(connector)}
        onToggleConnectorStatus={(connector) =>
          void handleToggleConnectorStatus(connector)
        }
        open={isManageConnectorsOpen}
        webhookConfig={notionWebhookConfig}
        webhookEvents={connectorWebhookEvents}
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
          }
        }}
        open={Boolean(pendingDisconnectConnector)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect connector?</AlertDialogTitle>
            <AlertDialogDescription>
              This disables syncing for the connector. Existing indexed sources
              remain in the knowledge base until you remove them separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDisconnectConnector ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
              <span className="line-clamp-2 break-words">
                {pendingDisconnectConnector.name}
              </span>
            </div>
          ) : null}
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
              className={buttonVariants({ variant: "destructive" })}
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
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
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
              Install reusable skills for {workspaceName || "the current workspace"}.
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
