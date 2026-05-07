"use client";

import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
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
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { HttpClientError } from "@sourceweft/sdk";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
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
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { apiBaseUrl, contentClient } from "../../../../lib/sdk";
import type { CitationRecord } from "./chat-canvas";
import { SourcePreviewPanel } from "./source-preview-panel";
import { expandSelectedSources, type SourceItem } from "./source-types";

const tabs = ["Library", "Skills", "Connectors", "Citations"] as const;
const addTabs = ["File", "Text"] as const;
const MAX_FILES = 20;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const SOURCE_TREE_INDENT_PX = 10;
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

type HubTab = (typeof tabs)[number];
type AddTab = (typeof addTabs)[number];
type SourceApiRecord = Awaited<
  ReturnType<typeof contentClient.listSources>
>["items"][number];
type CitationScope = "current" | "thread";
type SourceTreeNode = {
  source: SourceItem;
  children: SourceTreeNode[];
};
type SourceSelectionState = boolean | "indeterminate";

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
  status: "Connected" | "Syncing" | "Action needed";
  meta: string;
};

const connectors: ConnectorItem[] = [];

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
  Library: "Search sources...",
  Skills: "Search installed skills...",
  Citations: "Search citations...",
  Connectors: "Search connectors...",
};

const searchScopeLabels: Record<HubTab, string> = {
  Library: "Library",
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

function StatusDot({ status }: { status: SourceItem["status"] }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        status === "Indexed"
          ? "bg-emerald-500"
          : status === "Syncing"
            ? "bg-amber-500"
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
}) {
  const isDirectory = source.sourceType === "directory";
  const isSelected = selectionState === true;
  const isPartiallySelected = selectionState === "indeterminate";
  const metaLabel =
    isDirectory && childCount > 0
      ? `${childCount} item${childCount === 1 ? "" : "s"}`
      : source.meta;

  function handleRowClick(event: MouseEvent<HTMLDivElement>) {
    if (isBusy || isEditing) {
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
        !isBusy && !isEditing && "cursor-pointer",
        "hover:bg-accent/60",
      )}
      onClick={handleRowClick}
      style={{ paddingLeft: `${4 + depth * SOURCE_TREE_INDENT_PX}px` }}
    >
      {leading ?? <span className="size-5 shrink-0" />}
      <Checkbox
        checked={selectionState}
        className={cn(!isDirectory && !isEditing && "mt-0.5")}
        disabled={isBusy}
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
                disabled={isBusy}
                onClick={onToggle}
                title={isDirectory ? "Select folder" : "Select source"}
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

function buildSourceTree(sources: SourceItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  const byParent = new Map<string | null, SourceItem[]>();
  const byId = new Map(sources.map((source) => [source.id, source]));

  for (const source of sources) {
    const parentId =
      source.parentSourceId && byId.get(source.parentSourceId)?.sourceType === "directory"
        ? source.parentSourceId
        : null;
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

  function build(parentId: string | null, ancestorsMatch = false): SourceTreeNode[] {
    return (byParent.get(parentId) ?? [])
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

function countTreeNodes(nodes: SourceTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countTreeNodes(node.children), 0);
}

function collectTreeIds(node: SourceTreeNode): string[] {
  return [
    node.source.id,
    ...node.children.flatMap((child) => collectTreeIds(child)),
  ];
}

function getNodeSelectionState(
  node: SourceTreeNode,
  selectedSet: Set<string>,
  ancestorSelected = false,
): SourceSelectionState {
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

  const childWithExcludedNode = node.children.find((child) =>
    subtreeContainsSource(child, excludedNode.source.id),
  );
  if (!childWithExcludedNode) {
    return [node.source.id];
  }

  return node.children.flatMap((child) =>
    child.source.id === childWithExcludedNode.source.id
      ? selectSubtreeExcept(child, excludedNode)
      : [child.source.id],
  );
}

function normalizeSourceSelectionFromTree(
  nodes: SourceTreeNode[],
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);

  function normalizeNode(node: SourceTreeNode): string[] {
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
  const idsToRemove = new Set(collectTreeIds(node));

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
  return [...next, node.source.id];
}

function SourceTreeRow({
  node,
  depth,
  selectedIds,
  sourceById,
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
}: {
  node: SourceTreeNode;
  depth: number;
  selectedIds: string[];
  sourceById: Map<string, SourceItem>;
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
}) {
  const [open, setOpen] = useState(true);
  const source = node.source;
  const isDirectory = source.sourceType === "directory";
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const ancestorSelected = useMemo(() => {
    let parentId = source.parentSourceId;
    while (parentId) {
      if (selectedSet.has(parentId)) {
        return true;
      }
      parentId = sourceById.get(parentId)?.parentSourceId ?? null;
    }
    return false;
  }, [source.parentSourceId, selectedSet, sourceById]);
  const selectionState = getNodeSelectionState(
    node,
    selectedSet,
    ancestorSelected,
  );

  if (!isDirectory) {
    return (
      <SourceRow
        depth={depth}
        editTitle={editingTitle}
        isBusy={Boolean(rowBusyById[source.id])}
        isEditing={editingId === source.id}
        onCancelRename={onCancelRename}
        onAddSource={() => {}}
        onCreateDirectory={() => {}}
        onDelete={() => onDelete(source)}
        onDownload={() => onDownload(source)}
        onEditReadme={() => onEditReadme(source)}
        onEditTitleChange={onEditTitleChange}
        onMove={() => onMove(source)}
        onPreview={() => onPreview(source)}
        onReindex={() => onReindex(source)}
        onStartRename={() => onStartRename(source)}
        onSubmitRename={() => onSubmitRename(source.id)}
        onToggle={() => onToggle(node)}
        selectionState={selectionState}
        source={source}
      />
    );
  }

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
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
                <ChevronDown className="size-3.5" />
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
              depth={depth + 1}
              editingId={editingId}
              editingTitle={editingTitle}
              key={child.source.id}
              node={child}
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
              onStartRename={onStartRename}
              onSubmitRename={onSubmitRename}
              onToggle={onToggle}
              rowBusyById={rowBusyById}
              selectedIds={selectedIds}
              sourceById={sourceById}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function LibraryTab({
  sources,
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
}: {
  sources: SourceItem[];
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
}) {
  const tree = useMemo(
    () => buildSourceTree(sources, searchQuery),
    [sources, searchQuery],
  );
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );

  if (countTreeNodes(tree) === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        {searchQuery
          ? `No sources match "${searchQuery}"`
          : "No sources in this workspace yet."}
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {tree.map((node) => (
        <SourceTreeRow
          depth={0}
          editingId={editingId}
          editingTitle={editingTitle}
          key={node.source.id}
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
          onStartRename={onStartRename}
          onSubmitRename={onSubmitRename}
          onToggle={onToggle}
          rowBusyById={rowBusyById}
          selectedIds={selectedIds}
          sourceById={sourceById}
        />
      ))}
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
        <span>Library root</span>
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

function SkillRow({
  skill,
  selected,
  onToggle,
  onOpenSkill,
}: {
  skill: HubSkillItem;
  selected: boolean;
  onToggle: (id: string) => void;
  onOpenSkill: (catalogId: string) => void;
}) {
  function handleRowClick(event: MouseEvent<HTMLElement>) {
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
      )}
      onClick={handleRowClick}
    >
      <Checkbox
        checked={selected}
        className="mt-0.5"
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
}: {
  skills: HubSkillItem[];
  searchQuery: string;
  selectedSkillIds: string[];
  onSkillSelectionChange: (ids: string[]) => void;
  onOpenSkill: (catalogId: string) => void;
}) {
  const q = searchQuery.trim().toLowerCase();
  const selectedSet = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
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
    if (selectedSet.has(skillId)) {
      onSkillSelectionChange(selectedSkillIds.filter((id) => id !== skillId));
      return;
    }
    onSkillSelectionChange([...selectedSkillIds, skillId].slice(0, 5));
  }

  if (filtered.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        {searchQuery ? `No installed skills match "${searchQuery}"` : "No skills installed yet."}
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {filtered.map((skill) => (
        <SkillRow
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

function filterConnectors(items: ConnectorItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items;
  }
  return items.filter((connector) =>
    connector.name.toLowerCase().includes(q) ||
    connector.status.toLowerCase().includes(q) ||
    connector.meta.toLowerCase().includes(q),
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
  workspaceId,
  onSourceLoad,
  installedSkills = [],
  selectedSkillIds = [],
  onSkillSelectionChange = () => {},
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
  workspaceId?: string | null;
  onSourceLoad?: (sources: SourceItem[]) => void;
  installedSkills?: HubSkillItem[];
  selectedSkillIds?: string[];
  onSkillSelectionChange?: (ids: string[]) => void;
}) {
  const [activeTab, setActiveTab] = useState<HubTab>("Library");
  const [citationScope, setCitationScope] = useState<CitationScope>("current");
  const [searchQueries, setSearchQueries] = useState<Record<HubTab, string>>({
    Library: "",
    Skills: "",
    Citations: "",
    Connectors: "",
  });
  const searchQuery = searchQueries[activeTab];
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
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
    () => filterCitations(activeCitationItems, searchQueries.Citations),
    [activeCitationItems, searchQueries.Citations],
  );
  const filteredConnectors = useMemo(
    () => filterConnectors(connectors, searchQueries.Connectors),
    [searchQueries.Connectors],
  );
  const filteredSourceCount = useMemo(
    () => countFilteredSources(sources, searchQueries.Library),
    [searchQueries.Library, sources],
  );
  const filteredSkillCount = useMemo(
    () => countFilteredSkills(installedSkills, searchQueries.Skills),
    [installedSkills, searchQueries.Skills],
  );
  const activeCitationChunkId = activeCitationIndex
    ? citations[activeCitationIndex - 1]?.chunkId
    : null;
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addParentSourceId, setAddParentSourceId] = useState<string | null>(null);
  const [addTab, setAddTab] = useState<AddTab>("File");
  const [isCreateDirectoryOpen, setIsCreateDirectoryOpen] = useState(false);
  const [directoryTitle, setDirectoryTitle] = useState("");
  const [directoryContext, setDirectoryContext] = useState("");
  const [directoryParentSourceId, setDirectoryParentSourceId] = useState<string | null>(null);
  const [readmeSource, setReadmeSource] = useState<SourceItem | null>(null);
  const [readmeContent, setReadmeContent] = useState("");
  const [moveSource, setMoveSource] = useState<SourceItem | null>(null);
  const [moveParentSourceId, setMoveParentSourceId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  const [pendingSourceIds, setPendingSourceIds] = useState<string[]>([]);

  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [rowBusyById, setRowBusyById] = useState<Record<string, boolean>>({});
  const [previewSource, setPreviewSource] = useState<SourceItem | null>(null);
  const [previewSkillCatalogId, setPreviewSkillCatalogId] = useState<string | null>(null);
  const fullSourceTree = useMemo(() => buildSourceTree(sources, ""), [sources]);
  const selectedLibrarySources = useMemo(
    () => expandSelectedSources(sources, selectedIds),
    [selectedIds, sources],
  );

  function setActiveSearchQuery(value: string) {
    setSearchQueries((current) => ({
      ...current,
      [activeTab]: value,
    }));
  }

  useEffect(() => {
    setActiveTab("Library");
    setCitationScope("current");
  }, [mode]);

  const refreshSources = useCallback(async () => {
    if (!workspaceId) {
      setSources([]);
      onSourceLoad?.([]);
      return;
    }

    setIsLoading(true);
    setLoadingError(null);
    try {
      const result = await contentClient.listSources(workspaceId);
      const mapped = mapSourcesToUi(result.items);
      setSources(mapped);
      onSourceLoad?.(mapped);

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
      const message = getErrorMessage(error, "Failed to load sources.");
      setLoadingError(message);
      setSources([]);
      onSourceLoad?.([]);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, onSourceLoad]);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  useEffect(() => {
    if (!workspaceId || pendingSourceIds.length === 0) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const statuses = await Promise.all(
          pendingSourceIds.map(async (id) => ({
            id,
            status: await contentClient.getSourceStatus(workspaceId, id),
          })),
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
    Library: selectedLibrarySources.length,
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

  function setRowBusy(id: string, busy: boolean) {
    setRowBusyById((prev) => {
      if (busy) return { ...prev, [id]: true };
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

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

  const handleDeleteSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;
      const confirmed = window.confirm(`Delete ${source.sourceType === "directory" ? "folder" : "source"} "${source.title}"?`);
      if (!confirmed) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.deleteSource(workspaceId, source.id);
        toast.success("Source deleted.");
        onSelectionChange(selectedIds.filter((id) => id !== source.id));
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to delete source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [workspaceId, refreshSources, onSelectionChange, selectedIds],
  );

  const handleReindexSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.indexSource(workspaceId, source.id, {});
        toast.success("Re-index queued.");
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to re-index source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [workspaceId],
  );

  const handlePreviewSource = useCallback((source: SourceItem) => {
    if (source.sourceType === "directory") return;
    setPreviewSource(source);
  }, []);

  const handleOpenReadmeDialog = useCallback((source: SourceItem) => {
    if (source.sourceType !== "directory") return;
    setReadmeSource(source);
    setReadmeContent(source.contentText);
  }, []);

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

  const resetAddForm = useCallback(() => {
    setTextTitle("");
    setTextContent("");
    setFiles([]);
    setUploadProgress(0);
    setAddTab("File");
    setIsDragActive(false);
    setAddParentSourceId(null);
    dragDepthRef.current = 0;
  }, []);

  const handleOpenAddDialog = useCallback((parentSourceId: string | null = null) => {
    setAddParentSourceId(parentSourceId);
    setIsAddOpen(true);
  }, []);

  const handleCloseAddDialog = useCallback(
    (open: boolean) => {
      setIsAddOpen(open);
      if (!open) {
        resetAddForm();
      }
    },
    [resetAddForm],
  );

  const handleAddFiles = useCallback(
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
      const dropped = Array.from(event.dataTransfer.files ?? []);
      handleAddFiles(dropped);
    },
    [handleAddFiles],
  );

  const handleCreateTextSource = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }

    const contentText = textContent.trim();
    if (!contentText) {
      toast.error("Source content cannot be empty.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await contentClient.createSource(workspaceId, {
        title: textTitle.trim() || undefined,
        contentText,
        parentSourceId: addParentSourceId,
      });

      await contentClient.indexSource(workspaceId, created.source.id, {});
      setPendingSourceIds((prev) =>
        prev.includes(created.source.id) ? prev : [...prev, created.source.id],
      );

      toast.success("Source added and indexing started.");
      setIsAddOpen(false);
      resetAddForm();
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create source."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, textTitle, textContent, addParentSourceId, resetAddForm, refreshSources]);

  const handleUploadFiles = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    if (files.length === 0) {
      toast.error("Select files to upload first.");
      return;
    }

    setIsSubmitting(true);
    setUploadProgress(0);
    const createdSourceIds: string[] = [];
    const total = files.length;
    let processed = 0;

    try {
      for (const file of files) {
        const result = await contentClient.uploadSource(workspaceId, file, {
          parentSourceId: addParentSourceId,
        });
        createdSourceIds.push(result.source.id);
        processed += 1;
        setUploadProgress(Math.round((processed / total) * 100));
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
      setIsAddOpen(false);
      resetAddForm();
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to upload files."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, files, addParentSourceId, resetAddForm, refreshSources]);

  return (
    <>
      <aside className="flex h-full w-[410px] shrink-0 flex-col border-l bg-background">
        <div className="shrink-0 border-b px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-foreground">Sources</h2>
            {pendingSourceIds.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                syncing {pendingSourceIds.length}
              </span>
            ) : null}
          </div>

          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 rounded-xl bg-muted/35 pr-20 pl-8 text-xs"
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

          <div className="mt-2 flex flex-wrap gap-1 border-t pt-2">
            {tabs.map((tab) => (
              <button
                className={cn(
                  "rounded-lg px-2.5 py-1 text-[11px] transition-colors",
                  activeTab === tab
                    ? "bg-secondary text-foreground shadow-xs ring-1 ring-border"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                key={tab}
                onClick={() => setActiveTab(tab)}
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

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {activeTab === "Library" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Library
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {sources.length} sources
                  </span>
                  {searchQueries.Library ? (
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
                <div className="flex min-h-8 items-center justify-end gap-1.5">
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
                    onClick={() => handleOpenAddDialog(null)}
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
                <LibraryTab
                  editingId={editingSourceId}
                  editingTitle={editingTitle}
                  onCancelRename={handleCancelRename}
                  onDelete={handleDeleteSource}
                  onDownload={handleDownloadSource}
                  onEditReadme={handleOpenReadmeDialog}
                  onEditTitleChange={setEditingTitle}
                  onAddSource={handleOpenAddDialog}
                  onCreateDirectory={handleOpenCreateDirectory}
                  onMove={handleOpenMoveDialog}
                  onPreview={handlePreviewSource}
                  onReindex={handleReindexSource}
                  onStartRename={handleStartRename}
                  onSubmitRename={handleSubmitRename}
                  onToggle={handleToggle}
                  rowBusyById={rowBusyById}
                  searchQuery={searchQuery}
                  selectedIds={selectedIds}
                  sources={sources}
                />
              )}
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
                  {searchQueries.Skills ? (
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
                <Button asChild size="xs" type="button" variant="outline">
                  <Link href="/dashboard/skills">
                    <Sparkles className="size-3.5" />
                    Skills gallery
                  </Link>
                </Button>
              </div>

              <SkillsTab
                onOpenSkill={setPreviewSkillCatalogId}
                onSkillSelectionChange={onSkillSelectionChange}
                searchQuery={searchQuery}
                selectedSkillIds={selectedSkillIds}
                skills={installedSkills}
              />
            </section>
          )}

          {activeTab === "Citations" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Citations
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {citationScope === "thread"
                      ? `${threadCitationItems.length} in thread`
                      : `${currentCitationItems.length} current`}
                  </span>
                  {searchQueries.Citations ? (
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
                      onClick={() => setCitationScope(scope)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}

              {filteredCitationItems.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {searchQueries.Citations
                    ? `No citations match "${searchQueries.Citations}".`
                    : citationScope === "thread"
                    ? "No citations found in this thread."
                    : "No citations used in the selected answer."}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filteredCitationItems.map((citation) => {
                    const citationRecord = citation.citationRecord;
                    const displayIndex = activeCitationItems.findIndex(
                      (item) => item.id === citation.id,
                    ) + 1;
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
                          isActive &&
                            "border-primary/45 bg-primary/5 shadow-sm",
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
          )}

          {activeTab === "Connectors" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Connectors
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {connectors.length} connectors
                  </span>
                  {searchQueries.Connectors ? (
                    <span className="text-[10px] text-primary">
                      {filteredConnectors.length} found
                    </span>
                  ) : null}
                </div>
                <div className="flex min-h-8 w-[108px] items-center justify-end gap-1.5">
                  <Button size="xs" type="button" variant="outline">
                    <Link2 className="size-3.5" />
                    Connect
                  </Button>
                </div>
              </div>
              {filteredConnectors.length === 0 ? (
                <div className="rounded-2xl border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
                  {searchQueries.Connectors
                    ? `No connectors match "${searchQueries.Connectors}".`
                    : "No connectors available yet."}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filteredConnectors.map((connector: ConnectorItem) => (
                  <article
                    className="rounded-lg border bg-background p-2.5 shadow-xs"
                    key={connector.id}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">
                        {connector.name}
                      </p>
                      <span className="text-[11px] text-muted-foreground">
                        {connector.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {connector.meta}
                    </p>
                    {mode === "new" ? (
                      <div className="mt-3">
                        <Button size="xs" type="button" variant="outline">
                          <Upload className="size-3.5" />
                          Pull sources
                        </Button>
                      </div>
                    ) : null}
                  </article>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </aside>

      <Dialog onOpenChange={handleCloseAddDialog} open={isAddOpen}>
        <DialogContent
          className="w-[640px] max-w-[calc(100%-2rem)]"
          constrainWidth={false}
        >
          <DialogHeader>
            <DialogTitle>Add source</DialogTitle>
            <DialogDescription>
              Add text notes or upload files into your workspace library.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {addParentSourceId ? (
              <div className="flex items-center gap-1.5 rounded-lg border bg-muted/25 px-2.5 py-1.5 text-xs text-muted-foreground">
                <Folder className="size-3.5" />
                <span className="truncate">
                  {sources.find((source) => source.id === addParentSourceId)?.title ?? "Selected folder"}
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
                  onClick={() => setAddTab(tab)}
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
                    onChange={(e) => setTextTitle(e.target.value)}
                    placeholder="Title (optional)"
                    value={textTitle}
                  />
                  <Textarea
                    className="min-h-0 flex-1"
                    onChange={(e) => setTextContent(e.target.value)}
                    placeholder="Paste or write source content..."
                    value={textContent}
                  />
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
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                  >
                    <input
                      accept={SOURCE_FILE_ACCEPT}
                      className="hidden"
                      ref={fileInputRef}
                      multiple
                      onChange={(e) => {
                        handleAddFiles(Array.from(e.target.files ?? []));
                        e.currentTarget.value = "";
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
                        {files.map((file, idx) => (
                          <div
                            className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5"
                            key={`${file.name}-${file.size}-${idx}`}
                          >
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-foreground">
                                {file.name}
                              </span>
                            </div>
                            <TypeBadge label={getUploadFileLabel(file)} />
                            <Button
                              onClick={() =>
                                setFiles((prev) =>
                                  prev.filter((_, i) => i !== idx),
                                )
                              }
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
              onClick={() => handleCloseAddDialog(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                isSubmitting ||
                (addTab === "Text" && !textContent.trim()) ||
                (addTab === "File" && files.length === 0)
              }
              onClick={() =>
                addTab === "Text"
                  ? void handleCreateTextSource()
                  : void handleUploadFiles()
              }
              type="button"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Working...
                </>
              ) : (
                <>{addTab === "Text" ? "Create source" : "Upload files"}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setIsCreateDirectoryOpen} open={isCreateDirectoryOpen}>
        <DialogContent className="w-[520px] max-w-[calc(100%-2rem)]" constrainWidth={false}>
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>
              Add a directory to organize the Source Library.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              autoFocus
              onChange={(event) => setDirectoryTitle(event.target.value)}
              placeholder="Folder name"
              value={directoryTitle}
            />
            <Textarea
              className="min-h-28"
              onChange={(event) => setDirectoryContext(event.target.value)}
              placeholder="README context (optional)"
              value={directoryContext}
            />
            <DirectoryPicker
              onChange={setDirectoryParentSourceId}
              sources={sources}
              value={directoryParentSourceId}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={isSubmitting}
              onClick={() => setIsCreateDirectoryOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={isSubmitting || !directoryTitle.trim()}
              onClick={() => void handleCreateDirectory()}
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

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setMoveSource(null);
            setMoveParentSourceId(null);
          }
        }}
        open={Boolean(moveSource)}
      >
        <DialogContent className="w-[520px] max-w-[calc(100%-2rem)]" constrainWidth={false}>
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
            onChange={setMoveParentSourceId}
            sources={sources}
            value={moveParentSourceId}
          />
          <DialogFooter>
            <Button
              disabled={isSubmitting}
              onClick={() => setMoveSource(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => void handleMoveSource()}
              type="button"
            >
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

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setReadmeSource(null);
            setReadmeContent("");
          }
        }}
        open={Boolean(readmeSource)}
      >
        <DialogContent className="w-[640px] max-w-[calc(100%-2rem)]" constrainWidth={false}>
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
            onChange={(event) => setReadmeContent(event.target.value)}
            placeholder="README context for this folder..."
            value={readmeContent}
          />
          <DialogFooter>
            <Button
              disabled={isSubmitting}
              onClick={() => {
                setReadmeSource(null);
                setReadmeContent("");
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => void handleUpdateReadme()}
              type="button"
            >
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
    </>
  );
}
