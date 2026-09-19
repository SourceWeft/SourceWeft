"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { contentClient } from "../../../../lib/sdk";
import { toast } from "sonner";
import { useChatHubContext } from "./chat-hub-context";
import { SourcesHub } from "./sources-hub";
import { ArtifactPreviewPanel } from "./sources-hub";
import { isEmbedMode } from "../../../../lib/thread-embed-params";
import { SubagentPanel } from "../[threadId]/_thread/subagent-panel";
import { useWorkspaceLayout } from "../../_components/dashboard-workspace-layout";

export function HubSlot() {
  const { previewWidth } = useWorkspaceLayout();
  const context = useChatHubContext();
  const registration = context?.registration;

  const savedArtifactId = context?.desktop.getView()?.artifactId;
  useEffect(() => {
    if (
      !savedArtifactId ||
      !registration?.workspaceId ||
      registration.previewArtifact
    )
      return;
    let cancelled = false;
    void contentClient
      .getArtifact(registration.workspaceId, savedArtifactId)
      .then(({ artifact }) => {
        if (!cancelled) registration.onArtifactOpen(artifact);
      })
      .catch((e) => {
        if (!cancelled) toast.error(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [savedArtifactId, registration]);

  if (!registration) {
    return null;
  }

  if (registration.subagentPanel) {
    return (
      <SubagentPanel
        className="w-[min(640px,45vw)] min-w-[480px] max-w-[720px] shrink-0 border-l border-border/70 animate-in slide-in-from-right-4 duration-200"
        panel={registration.subagentPanel}
      />
    );
  }

  if (registration.previewArtifact) {
    return (
      <div
        data-testid="docked-artifact-preview"
        className="h-full shrink-0"
        style={{ width: previewWidth }}
      >
        <ArtifactPreviewPanel
          artifact={registration.previewArtifact}
          className="h-full min-w-0 w-full"
          onClose={() => {
            context?.desktop.saveView({
              ...context.desktop.getView(),
              artifactId: undefined,
            });
            registration.onArtifactPreviewClose();
          }}
          workspaceId={registration.workspaceId}
        />
      </div>
    );
  }

  return (
    <SourcesHub
      key={`${context?.desktop.contextKey}:${context?.desktop.viewVersion}`}
      activeCitationIndex={registration.activeCitationIndex}
      artifactsRefreshKey={registration.artifactsRefreshKey}
      citations={registration.displayedCitations}
      currentCitationMessageId={registration.activeCitationMessageId}
      disabledToolNames={registration.disabledToolNames}
      initialSources={registration.initialSources}
      initialSourcesLoaded={registration.initialSourcesLoaded}
      installedSkills={registration.availableSkills}
      hubSkills={registration.hubSkills}
      capabilityCatalog={registration.capabilityCatalog}
      mode={registration.mode}
      draftWorkContext={registration.draftWorkContext}
      onWorkFolderChange={registration.onWorkFolderChange}
      onChooseWorkFolder={registration.onChooseWorkFolder}
      onArtifactOpen={(artifact) => {
        context?.desktop.saveView({
          ...context.desktop.getView(),
          artifactId: artifact.id,
        });
        registration.onArtifactOpen(artifact);
      }}
      onCitationLocate={registration.onCitationLocate}
      onCitationOpen={registration.onCitationOpen}
      onConnectorsChange={registration.onConnectorsChange}
      onMcpSelectionChange={registration.onMcpSelectionChange}
      onSelectionChange={registration.onSelectionChange}
      onSkillSelectionChange={registration.onSkillSelectionChange}
      onSkillsCatalogChange={registration.onSkillsCatalogChange}
      onSourceLoad={registration.onSourceLoad}
      onSourceMerge={registration.onSourceMerge}
      selectedIds={registration.activeSourceIds}
      selectedMcpInstallIds={registration.activeMcpInstallIds}
      selectedMcpToolIds={registration.activeMcpToolIds}
      selectedSkillIds={registration.activeSkillIds}
      threadCitations={registration.threadCitations}
      threadId={registration.threadId}
      onPopOut={context?.desktop.available ? context.desktop.open : undefined}
      windowBusy={context?.desktop.mode === "opening"}
      initialView={context?.desktop.getView()}
      onViewChange={context?.desktop.saveView}
      viewKey={context?.desktop.contextKey}
      variant="panel"
      workfilesRefreshKey={registration.workfilesRefreshKey}
      workspaceId={registration.workspaceId}
      workspaceName={registration.workspaceName}
    />
  );
}

function MobileHubDrawer() {
  const context = useChatHubContext();
  const registration = context?.registration;

  if (!registration) {
    return null;
  }

  return (
    <Sheet open={context.mobileHubOpen} onOpenChange={context.setMobileHubOpen}>
      <SheetContent
        onCloseAutoFocus={(event) => {
          if (context.desktop.mode === "detached") {
            event.preventDefault();
            return;
          }
          const trigger =
            document.querySelector<HTMLButtonElement>("[data-hub-toggle]");
          if (trigger) {
            event.preventDefault();
            trigger.focus();
          }
        }}
        className="w-[calc(100vw-1rem)] max-w-[360px] gap-0 overflow-hidden p-0 sm:w-[380px] sm:max-w-[380px] [&>button]:hidden"
        side="right"
      >
        <SheetTitle className="sr-only">Hub</SheetTitle>
        <SourcesHub
          key={`${context.desktop.contextKey}:${context.desktop.viewVersion}`}
          activeCitationIndex={registration.activeCitationIndex}
          artifactsRefreshKey={registration.artifactsRefreshKey}
          citations={registration.displayedCitations}
          currentCitationMessageId={registration.activeCitationMessageId}
          disabledToolNames={registration.disabledToolNames}
          initialSources={registration.initialSources}
          initialSourcesLoaded={registration.initialSourcesLoaded}
          installedSkills={registration.availableSkills}
          hubSkills={registration.hubSkills}
          capabilityCatalog={registration.capabilityCatalog}
          mode={registration.mode}
          draftWorkContext={registration.draftWorkContext}
          onWorkFolderChange={registration.onWorkFolderChange}
          onChooseWorkFolder={registration.onChooseWorkFolder}
          onArtifactOpen={(artifact) => {
            registration.onArtifactOpen(artifact);
            context.setMobileHubOpen(false);
          }}
          onCitationLocate={registration.onCitationLocate}
          onCitationOpen={registration.onCitationOpen}
          onConnectorsChange={registration.onConnectorsChange}
          onMcpSelectionChange={registration.onMcpSelectionChange}
          onSelectionChange={registration.onSelectionChange}
          onSkillSelectionChange={registration.onSkillSelectionChange}
          onSkillsCatalogChange={registration.onSkillsCatalogChange}
          onSourceLoad={registration.onSourceLoad}
          onSourceMerge={registration.onSourceMerge}
          selectedIds={registration.activeSourceIds}
          selectedMcpInstallIds={registration.activeMcpInstallIds}
          selectedMcpToolIds={registration.activeMcpToolIds}
          selectedSkillIds={registration.activeSkillIds}
          threadCitations={registration.threadCitations}
          threadId={registration.threadId}
          onClose={() => context.setMobileHubOpen(false)}
          onPopOut={
            context.desktop.available ? context.desktop.open : undefined
          }
          windowBusy={context.desktop.mode === "opening"}
          initialView={context.desktop.getView()}
          onViewChange={context.desktop.saveView}
          viewKey={context.desktop.contextKey}
          variant="drawer"
          workfilesRefreshKey={registration.workfilesRefreshKey}
          workspaceId={registration.workspaceId}
          workspaceName={registration.workspaceName}
        />
      </SheetContent>
    </Sheet>
  );
}

function ChatHubScaffold({
  children,
  embed,
}: {
  children: ReactNode;
  embed: boolean;
}) {
  const { sourcesVisible } = useDashboardChatState();
  const { canDockHub } = useWorkspaceLayout();
  const context = useChatHubContext();

  // An embedded thread (the document inside a sub-agent panel) is just the
  // conversation: no hub beside it, no drawer over it.
  if (embed) {
    return (
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    );
  }

  // A sub-agent panel takes the right-hand slot even while the hub is hidden;
  // otherwise the slot follows the hub toggle and the desktop hub host.
  const slotVisible =
    canDockHub &&
    context?.desktop.mode !== "detached" &&
    context?.desktop.inlineVisible !== false &&
    (sourcesVisible || Boolean(context?.registration.subagentPanel));

  return (
    <>
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        {slotVisible ? <HubSlot /> : null}
      </div>
      {!canDockHub ? <MobileHubDrawer /> : null}
    </>
  );
}

export default function ChatWorkspaceShell({
  children,
}: {
  children: ReactNode;
}) {
  const searchParams = useSearchParams();
  const embed = isEmbedMode(searchParams);

  return <ChatHubScaffold embed={embed}>{children}</ChatHubScaffold>;
}
