"use client";

import dynamic from "next/dynamic";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { SourcesHubPanelSkeleton } from "../../../../_components/route-loading-skeleton";
import type { ChatHubSubagentPanel } from "../../_components/chat-hub-context";
import type { ArtifactListItem } from "../../_components/sources-hub";
import { SubagentPanel } from "./subagent-panel";

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
  isDesktopPanel,
  isPersistentLayout,
  onArtifactPreviewClose,
  previewArtifact,
  sourcesVisible,
  subagentPanel,
  workspaceId,
}: {
  isDesktopPanel: boolean;
  /** Above this breakpoint the sub-agent panel lives in the hub slot instead. */
  isPersistentLayout: boolean;
  onArtifactPreviewClose: () => void;
  previewArtifact: ArtifactListItem | null;
  sourcesVisible: boolean;
  subagentPanel: ChatHubSubagentPanel | null;
  workspaceId: string | null;
}) {
  return (
    <>
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

      {/* On narrow screens the sub-agent conversation slides in as a drawer. */}
      <Sheet
        open={Boolean(subagentPanel && !isPersistentLayout)}
        onOpenChange={(open) => {
          if (!open) {
            subagentPanel?.onClose();
          }
        }}
      >
        <SheetContent
          className="w-[calc(100vw-1rem)] max-w-[480px] gap-0 overflow-hidden p-0 sm:max-w-[480px] [&>button]:hidden"
          side="right"
        >
          <SheetTitle className="sr-only">Sub-agent conversation</SheetTitle>
          {subagentPanel ? <SubagentPanel panel={subagentPanel} /> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
