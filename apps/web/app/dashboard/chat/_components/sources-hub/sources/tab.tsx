import { useMemo } from "react";
import { FileText } from "lucide-react";

import {
  buildSourceSelectionStateMap,
  buildSourceTreeFromIndex,
  countTreeNodes,
  flattenVisibleSourceTree,
  type SourceTreeIndex,
  type SourceTreeNode,
} from "../source-tree";
import type { SourceItem } from "../../source-types";
import { useVirtualRows } from "../use-virtual-rows";
import { HubEmptyState } from "../components/hub-empty-state";
import { SourceTreeRow, sourceMatchesQuery } from "./components";

const SOURCE_TREE_VIRTUALIZE_THRESHOLD = 400;
const SOURCE_TREE_ROW_HEIGHT_PX = 40;
const SOURCE_TREE_OVERSCAN_ROWS = 12;

export function SourcesTab({
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
