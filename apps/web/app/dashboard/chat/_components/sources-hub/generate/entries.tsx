"use client";

import type { ComponentType } from "react";
import { Table2, type LucideIcon } from "lucide-react";
import { TableGenerateDialog } from "../../table-generate/table-generate-dialog";

/**
 * What the source hub's "Generate" menu offers for the selected sources. Each
 * entry brings its own dialog; the menu only knows the selection, the thread
 * the result belongs to and how to open what was queued. Adding a kind of
 * output (flashcards, a quiz, a mind map) is one more entry here, a label
 * under `dashboardSourcesHub.generate`, and its dialog.
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
export type GenerateLabelKey = "table";

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

export const GENERATE_ENTRIES: readonly GenerateEntry[] = [
  { id: "table", labelKey: "table", icon: Table2, Dialog: TableEntryDialog },
];
