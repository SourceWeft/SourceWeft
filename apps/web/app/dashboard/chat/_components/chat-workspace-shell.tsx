"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { ChatHubProvider, useChatHubContext } from "./chat-hub-context";
import type { ChatHubMode } from "./chat-hub-context";
import { HUB_STABILITY_PERSISTENT_SHELL_ENABLED } from "./chat-workspace-shell-feature-flag";
import { SourcesHub } from "./sources-hub";
import { ArtifactPreviewPanel } from "./sources-hub";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function HubSlot() {
  const context = useChatHubContext();
  const registration = context?.registration;

  if (!registration) {
    return null;
  }

  if (registration.previewArtifact) {
    return (
      <ArtifactPreviewPanel
        artifact={registration.previewArtifact}
        className="w-[min(640px,45vw)] min-w-[480px] max-w-[720px] shrink-0 animate-in slide-in-from-right-4 duration-200"
        onClose={registration.onArtifactPreviewClose}
        workspaceId={registration.workspaceId}
      />
    );
  }

  return (
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
      onArtifactOpen={registration.onArtifactOpen}
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

function ChatHubScaffold({
  children,
  mode,
}: {
  children: ReactNode;
  mode: ChatHubMode;
}) {
  const { sourcesVisible, workspaceId, workspaceName } =
    useDashboardChatState();
  const isDesktopPanel = useMediaQuery("(min-width: 1024px)");
  const isPersistentLayout = useMediaQuery("(min-width: 768px)");

  return (
    <ChatHubProvider initialValue={{ mode, workspaceId, workspaceName }}>
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        {sourcesVisible && isPersistentLayout ? <HubSlot /> : null}
      </div>
      {!isDesktopPanel ? <MobileHubDrawer /> : null}
    </ChatHubProvider>
  );
}

export default function ChatWorkspaceShell({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const mode: ChatHubMode = pathname?.endsWith("/chat") ? "new" : "thread";

  if (!HUB_STABILITY_PERSISTENT_SHELL_ENABLED) {
    return <>{children}</>;
  }

  return <ChatHubScaffold mode={mode}>{children}</ChatHubScaffold>;
}
