import type { CSSProperties, MouseEvent, ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  MoveRight,
  Music2,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";

import { GlobalIcon } from "@sourceweft/ui-web/components/ui/global-icon";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@sourceweft/ui-web/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { RawImage } from "../../../../../_components/raw-image";
import { connectorCatalog } from "../connectors/catalog";
import { PlugIcon } from "../connectors/components";
import { memoComponent } from "../memo-component";
import {
  isSelectableSource,
  type SourceSelectionState,
  type SourceTreeNode,
} from "../source-tree";
import { TypeBadge } from "../type-badge";
import type { SourceItem } from "../../source-types";

const SOURCE_TREE_INDENT_PX = 10;

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

export function SourceTypeIcon({
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

export function sourceMatchesQuery(source: SourceItem, q: string) {
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

export const SourceTreeRow = memoComponent(function SourceTreeRow({
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
