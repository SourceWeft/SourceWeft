"use client";

import dynamic from "next/dynamic";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import type { DashboardShortcutDefinition } from "../../../_components/dashboard-shortcuts";
import { DashboardShortcutsDialog } from "../../../_components/dashboard-shortcuts";
import type {
  ByokCredentialItem,
  ByokModelSelection,
  ByokProviderOption,
  ByokSavedModelItem,
} from "../../_components/byok-state";
import type { ByokModelConfigDefaults } from "../../_components/byok-model-config-dialog";
import type {
  CitationRecord,
} from "../../_components/chat-canvas";
import type {
  ModelItem,
  ModelType,
} from "../../_components/model-catalog-utils";
import type { SourceItem } from "../../_components/source-types";
import {
  basename,
  formatBytes,
  workfilePurposeLabel,
  type WorkfileDetail,
} from "./message-normalizers";

const SourcePreviewPanel = dynamic(
  () =>
    import("../../_components/source-preview-panel").then(
      (mod) => mod.SourcePreviewPanel,
    ),
  { ssr: false },
);

const ByokModelConfigDialog = dynamic(
  () =>
    import("../../_components/byok-model-config-dialog").then(
      (mod) => mod.ByokModelConfigDialog,
    ),
  { ssr: false },
);

type ByokConfiguredInput = {
  model?: ModelItem;
  selection?: ByokModelSelection;
  type: ModelType;
};

export function ThreadDialogs({
  byokCredentials,
  byokModelConfig,
  byokProviders,
  onByokConfigured,
  onByokModelConfigOpenChange,
  onByokStateChange,
  onPreviewSourceOpenChange,
  onPreviewWorkfileOpenChange,
  onShortcutsOpenChange,
  previewCitation,
  previewSource,
  previewWorkfile,
  shortcutDefinitions,
  shortcutsOpen,
  workspaceId,
}: {
  byokCredentials: ByokCredentialItem[];
  byokModelConfig: ByokModelConfigDefaults | null;
  byokProviders: ByokProviderOption[];
  onByokConfigured: (input: ByokConfiguredInput) => void;
  onByokModelConfigOpenChange: (open: boolean) => void;
  onByokStateChange: (input: {
    credentials: ByokCredentialItem[];
    models: ByokSavedModelItem[];
    providers: ByokProviderOption[];
  }) => void;
  onPreviewSourceOpenChange: (open: boolean) => void;
  onPreviewWorkfileOpenChange: (open: boolean) => void;
  onShortcutsOpenChange: (open: boolean) => void;
  previewCitation: CitationRecord | null;
  previewSource: SourceItem | null;
  previewWorkfile: WorkfileDetail | null;
  shortcutDefinitions: DashboardShortcutDefinition[];
  shortcutsOpen: boolean;
  workspaceId: string | null;
}) {
  return (
    <>
      <ByokModelConfigDialog
        defaults={byokModelConfig}
        credentials={byokCredentials}
        onConfigured={onByokConfigured}
        onOpenChange={onByokModelConfigOpenChange}
        onStateChange={onByokStateChange}
        open={Boolean(byokModelConfig)}
        providers={byokProviders}
        workspaceId={workspaceId}
      />

      <DashboardShortcutsDialog
        definitions={shortcutDefinitions}
        onOpenChange={onShortcutsOpenChange}
        open={shortcutsOpen}
      />

      <SourcePreviewPanel
        citation={previewCitation}
        onOpenChange={onPreviewSourceOpenChange}
        open={Boolean(previewCitation || previewSource)}
        source={previewSource}
        workspaceId={workspaceId}
      />

      <Dialog onOpenChange={onPreviewWorkfileOpenChange} open={Boolean(previewWorkfile)}>
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
    </>
  );
}
