"use client";

import type { ComponentType } from "react";
import {
  GalleryVerticalEnd,
  ListChecks,
  Network,
  Table2,
  type LucideIcon,
} from "lucide-react";
import type { StudyArtifactType } from "@sourceweft/contracts/study";
import { StudyGenerateDialog } from "../../study-generate/study-generate-dialog";
import { TableGenerateDialog } from "../../table-generate/table-generate-dialog";

/**
 * What the source hub's "Generate" menu offers for the selected sources. Each
 * entry brings its own dialog; the menu only knows the selection, the thread
 * the result belongs to and how to open what was queued. Adding a kind of
 * output is one more entry here, a label under
 * `dashboardSourcesHub.generate`, and its dialog.
 */

export type GenerateSource = { id: string; title: string };

export type GenerateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  threadId: string;
  /** The selected sources, folders expanded; never empty. */
  sources: readonly GenerateSource[];
  /** The queued artifact, for the app to open. */
  onCreated: (artifactId: string) => void;
};

/** A label key under `dashboardSourcesHub.generate`. */
export type GenerateLabelKey = "table" | StudyArtifactType;

export type GenerateEntry = {
  id: string;
  labelKey: GenerateLabelKey;
  icon: LucideIcon;
  Dialog: ComponentType<GenerateDialogProps>;
};

function TableEntryDialog({
  open,
  onOpenChange,
  workspaceId,
  threadId,
  sources,
  onCreated,
}: GenerateDialogProps) {
  return (
    <TableGenerateDialog
      onOpenChange={onOpenChange}
      onQueued={(queued) => onCreated(queued.artifactId)}
      open={open}
      sources={sources}
      target={{ kind: "generate", threadId }}
      workspaceId={workspaceId}
    />
  );
}

/** One study type's entry: the shared study dialog for that type. */
function studyEntryDialog(artifactType: StudyArtifactType) {
  function StudyEntryDialog({
    open,
    onOpenChange,
    workspaceId,
    threadId,
    sources,
    onCreated,
  }: GenerateDialogProps) {
    return (
      <StudyGenerateDialog
        artifactType={artifactType}
        onOpenChange={onOpenChange}
        onQueued={(queued) => onCreated(queued.artifactId)}
        open={open}
        sources={sources}
        target={{ kind: "generate", threadId }}
        workspaceId={workspaceId}
      />
    );
  }
  return StudyEntryDialog;
}

export const GENERATE_ENTRIES: readonly GenerateEntry[] = [
  { id: "table", labelKey: "table", icon: Table2, Dialog: TableEntryDialog },
  {
    id: "flashcards",
    labelKey: "flashcards",
    icon: GalleryVerticalEnd,
    Dialog: studyEntryDialog("flashcards"),
  },
  { id: "quiz", labelKey: "quiz", icon: ListChecks, Dialog: studyEntryDialog("quiz") },
  { id: "mindmap", labelKey: "mindmap", icon: Network, Dialog: studyEntryDialog("mindmap") },
];
