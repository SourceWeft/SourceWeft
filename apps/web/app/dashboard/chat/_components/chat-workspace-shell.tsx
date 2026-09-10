"use client";

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
          variant="drawer"
          workfilesRefreshKey={registration.workfilesRefreshKey}
          workspaceId={registration.workspaceId}
          workspaceName={registration.workspaceName}
        />
      </SheetContent>
    </Sheet>
  );
}

function ChatHubScaffold({ children }: { children: ReactNode }) {
  const { sourcesVisible } = useDashboardChatState();
  const { canDockHub } = useWorkspaceLayout();
  const context = useChatHubContext();

  return (
    <>
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        {sourcesVisible &&
        canDockHub &&
        context?.desktop.mode !== "detached" &&
        context?.desktop.inlineVisible !== false ? (
          <HubSlot />
        ) : null}
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
  return <ChatHubScaffold>{children}</ChatHubScaffold>;
}
