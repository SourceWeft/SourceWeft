"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { ChatHubProvider, useChatHubContext } from "./chat-hub-context";
import type { ChatHubMode } from "./chat-hub-context";
import { SourcesHub } from "./sources-hub";
import { ArtifactPreviewPanel } from "./sources-hub";
import { BREAKPOINTS, useMediaQuery } from "../../../../lib/use-media-query";
import { isEmbedMode } from "../../../../lib/thread-embed-params";
import { SubagentPanel } from "../[threadId]/_thread/subagent-panel";

function HubSlot() {
  const context = useChatHubContext();
  const registration = context?.registration;

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

function ChatHubBody({
  children,
  embed,
}: {
  children: ReactNode;
  embed: boolean;
}) {
  const { sourcesVisible } = useDashboardChatState();
  const context = useChatHubContext();
  const isDesktopPanel = useMediaQuery(BREAKPOINTS.lg);
  const isPersistentLayout = useMediaQuery(BREAKPOINTS.md);

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
  // otherwise the slot follows the hub toggle as before.
  const slotVisible =
    isPersistentLayout &&
    (sourcesVisible || Boolean(context?.registration.subagentPanel));

  return (
    <>
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        {slotVisible ? <HubSlot /> : null}
      </div>
      {!isDesktopPanel ? <MobileHubDrawer /> : null}
    </>
  );
}

function ChatHubScaffold({
  children,
  embed,
  mode,
}: {
  children: ReactNode;
  embed: boolean;
  mode: ChatHubMode;
}) {
  const { workspaceId, workspaceName } = useDashboardChatState();

  return (
    <ChatHubProvider initialValue={{ mode, workspaceId, workspaceName }}>
      <ChatHubBody embed={embed}>{children}</ChatHubBody>
    </ChatHubProvider>
  );
}

export default function ChatWorkspaceShell({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode: ChatHubMode = pathname?.endsWith("/chat") ? "new" : "thread";
  const embed = isEmbedMode(searchParams);

  return (
    <ChatHubScaffold embed={embed} mode={mode}>
      {children}
    </ChatHubScaffold>
  );
}
