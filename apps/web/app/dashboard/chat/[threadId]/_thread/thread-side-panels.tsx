"use client";

import dynamic from "next/dynamic";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { SourcesHubPanelSkeleton } from "../../../../_components/route-loading-skeleton";
import type { ArtifactListItem } from "../../_components/sources-hub";

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
  onArtifactPreviewClose,
  previewArtifact,
  sourcesVisible,
  workspaceId,
}: {
  isDesktopPanel: boolean;
  onArtifactPreviewClose: () => void;
  previewArtifact: ArtifactListItem | null;
  sourcesVisible: boolean;
  workspaceId: string | null;
}) {
  return (
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
  );
}
