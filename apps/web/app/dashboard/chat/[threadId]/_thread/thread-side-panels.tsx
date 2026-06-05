"use client";

import dynamic from "next/dynamic";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { SourcesHubPanelSkeleton } from "../../../../_components/route-loading-skeleton";
import type {
  ArtifactListItem,
  ThreadCitationRecord,
} from "../../_components/sources-hub";
import type {
  ChatSkillItem,
  ChatToolName,
  CitationRecord,
} from "../../_components/chat-canvas";
import type { SourceItem } from "../../_components/source-types";
import type { SourceConnector } from "@sourceweft/sdk";
import type { McpToolSelection } from "@sourceweft/sdk";

const SourcesHub = dynamic(
  () => import("../../_components/sources-hub").then((mod) => mod.SourcesHub),
  {
    loading: () => (
      <SourcesHubPanelSkeleton className="hidden h-full w-[410px] shrink-0 border-l md:flex" />
    ),
    ssr: false,
  },
);

const ArtifactPreviewPanel = dynamic(
  () =>
    import("../../_components/sources-hub").then(
      (mod) => mod.ArtifactPreviewPanel,
    ),
  {
    loading: () => (
      <SourcesHubPanelSkeleton className="hidden w-[min(640px,45vw)] shrink-0 md:block" />
    ),
    ssr: false,
  },
);

export function ThreadSidePanels({
  activeCitationIndex,
  activeCitationMessageId,
  activeMcpInstallIds,
  activeMcpToolIds,
  activeSkillIds,
  activeSourceIds,
  artifactsRefreshKey,
  availableSkills,
  disabledToolNames,
  displayedCitations,
  hubDrawerOpen,
  initialSourcesForWorkspace,
  initialSourcesLoaded,
  isDesktopPanel,
  isPersistentLayout,
  loadAvailableSkills,
  onConnectorsChange,
  onArtifactOpen,
  onArtifactPreviewClose,
  onCitationLocate,
  onCitationOpen,
  onHubDrawerOpenChange,
  onLibrarySourcesLoad,
  onLibrarySourcesMerge,
  onMcpSelectionChange,
  onSelectionChange,
  onSkillSelectionChange,
  previewArtifact,
  sourcesVisible,
  threadCitations,
  threadId,
  workfilesRefreshKey,
  workspaceId,
  workspaceName,
  usePersistentHub = false,
}: {
  activeCitationIndex: number | null;
  activeCitationMessageId: string | null;
  activeMcpInstallIds: string[];
  activeMcpToolIds: string[];
  activeSkillIds: string[];
  activeSourceIds: string[];
  artifactsRefreshKey: number;
  availableSkills: ChatSkillItem[];
  disabledToolNames: ChatToolName[];
  displayedCitations: CitationRecord[];
  hubDrawerOpen: boolean;
  initialSourcesForWorkspace: SourceItem[];
  initialSourcesLoaded: boolean;
  isDesktopPanel: boolean;
  isPersistentLayout: boolean;
  loadAvailableSkills: () => Promise<void>;
  onConnectorsChange?: (connectors: SourceConnector[]) => void;
  onArtifactOpen: (artifact: ArtifactListItem) => void;
  onArtifactPreviewClose: () => void;
  onCitationLocate: (messageId: string) => void;
  onCitationOpen: (
    citation: CitationRecord,
    context?: { messageId?: string },
  ) => void;
  onHubDrawerOpenChange: (open: boolean) => void;
  onLibrarySourcesLoad: (sources: SourceItem[]) => void;
  onLibrarySourcesMerge: (sources: SourceItem[]) => void;
  onMcpSelectionChange: (selection: McpToolSelection) => void;
  onSelectionChange: (sourceIds: string[]) => void;
  onSkillSelectionChange: (skillIds: string[]) => void;
  previewArtifact: ArtifactListItem | null;
  sourcesVisible: boolean;
  threadCitations: ThreadCitationRecord[];
  threadId: string;
  workfilesRefreshKey: number;
  workspaceId: string | null;
  workspaceName: string | null;
  usePersistentHub?: boolean;
}) {
  return (
    <>
      {sourcesVisible &&
      isPersistentLayout &&
      !previewArtifact &&
      !usePersistentHub ? (
        <SourcesHub
          activeCitationIndex={activeCitationIndex}
          artifactsRefreshKey={artifactsRefreshKey}
          citations={displayedCitations}
          currentCitationMessageId={activeCitationMessageId}
          disabledToolNames={disabledToolNames}
          installedSkills={availableSkills}
          mode="thread"
          onArtifactOpen={onArtifactOpen}
          onCitationLocate={onCitationLocate}
          onCitationOpen={onCitationOpen}
          initialSources={initialSourcesForWorkspace}
          initialSourcesLoaded={initialSourcesLoaded}
          onSkillSelectionChange={onSkillSelectionChange}
          onSelectionChange={onSelectionChange}
          onSkillsCatalogChange={loadAvailableSkills}
          onMcpSelectionChange={onMcpSelectionChange}
          onConnectorsChange={onConnectorsChange}
          onSourceLoad={onLibrarySourcesLoad}
          onSourceMerge={onLibrarySourcesMerge}
          selectedIds={activeSourceIds}
          selectedSkillIds={activeSkillIds}
          selectedMcpInstallIds={activeMcpInstallIds}
          selectedMcpToolIds={activeMcpToolIds}
          threadCitations={threadCitations}
          threadId={threadId}
          workfilesRefreshKey={workfilesRefreshKey}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
        />
      ) : null}

      {sourcesVisible && previewArtifact && isDesktopPanel && !usePersistentHub ? (
        <ArtifactPreviewPanel
          artifact={previewArtifact}
          className="w-[min(640px,45vw)] min-w-[480px] max-w-[720px] shrink-0 animate-in slide-in-from-right-4 duration-200"
          onClose={onArtifactPreviewClose}
          workspaceId={workspaceId}
        />
      ) : null}

      <Sheet
        open={Boolean(sourcesVisible && previewArtifact && !isDesktopPanel)}
        onOpenChange={(open) => {
          if (!open) {
            onArtifactPreviewClose();
          }
        }}
      >
        <SheetContent
          className="h-[90svh] max-h-[90svh] gap-0 overflow-hidden p-0 [&>button]:hidden"
          side="bottom"
        >
          <SheetTitle className="sr-only">
            {previewArtifact ? "Artifact preview" : "Artifact"}
          </SheetTitle>
          {previewArtifact ? (
            <ArtifactPreviewPanel
              artifact={previewArtifact}
              className="border-l-0"
              onClose={onArtifactPreviewClose}
              workspaceId={workspaceId}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet
        open={usePersistentHub ? false : hubDrawerOpen}
        onOpenChange={onHubDrawerOpenChange}
      >
        <SheetContent
          className="w-[calc(100vw-1rem)] max-w-[360px] gap-0 overflow-hidden p-0 sm:w-[380px] sm:max-w-[380px] [&>button]:hidden"
          side="right"
        >
          <SheetTitle className="sr-only">Hub</SheetTitle>
          <SourcesHub
            activeCitationIndex={activeCitationIndex}
            artifactsRefreshKey={artifactsRefreshKey}
            citations={displayedCitations}
            currentCitationMessageId={activeCitationMessageId}
            disabledToolNames={disabledToolNames}
            installedSkills={availableSkills}
            mode="thread"
            onClose={() => onHubDrawerOpenChange(false)}
            onArtifactOpen={(artifact) => {
              onArtifactOpen(artifact);
              onHubDrawerOpenChange(false);
            }}
            onCitationLocate={onCitationLocate}
            onCitationOpen={onCitationOpen}
            initialSources={initialSourcesForWorkspace}
            initialSourcesLoaded={initialSourcesLoaded}
            onSkillSelectionChange={onSkillSelectionChange}
            onSelectionChange={onSelectionChange}
            onSkillsCatalogChange={loadAvailableSkills}
            onMcpSelectionChange={onMcpSelectionChange}
            onConnectorsChange={onConnectorsChange}
            onSourceLoad={onLibrarySourcesLoad}
            onSourceMerge={onLibrarySourcesMerge}
            selectedIds={activeSourceIds}
            selectedSkillIds={activeSkillIds}
            selectedMcpInstallIds={activeMcpInstallIds}
            selectedMcpToolIds={activeMcpToolIds}
            threadCitations={threadCitations}
            threadId={threadId}
            variant="drawer"
            workfilesRefreshKey={workfilesRefreshKey}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
