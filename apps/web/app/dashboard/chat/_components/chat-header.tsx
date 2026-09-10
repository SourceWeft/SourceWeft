"use client";

import type { ComponentProps, ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useElementSize } from "../../../../lib/use-element-size";
import { useWorkspaceLayout } from "../../_components/dashboard-workspace-layout";
import { ChatWorkContext, type ChatCreationContext } from "./chat-work-context";

import { useChatHubContext } from "./chat-hub-context";

const HeaderModelSelector = dynamic(
  () =>
    import("./header-model-selector").then((mod) => mod.HeaderModelSelector),
  {
    ssr: false,
    loading: () => (
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-muted sm:w-28" />
    ),
  },
);

type Props = Omit<
  ComponentProps<typeof HeaderModelSelector>,
  "isLoading" | "compact" | "iconOnly"
> & {
  creationContext?: ChatCreationContext;
  creationDisabled?: boolean;
  threadTitle: string;
  threadId?: string;
  workspaceId: string | null;
  isModelCatalogLoading?: boolean;
  isPersistentLayout: boolean;
  sourcesVisible: boolean;
  onToggleSources: () => void;
  onOpenHub: () => void;
  presenceSlot?: ReactNode;
};

/** New and existing conversations use the same header and execution status. */
export function ChatHeader({
  threadTitle,
  creationContext,
  creationDisabled,
  threadId,
  workspaceId,
  isModelCatalogLoading,
  isPersistentLayout,
  sourcesVisible,
  onToggleSources,
  onOpenHub,
  presenceSlot,
  ...models
}: Props) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const { conversationsOpen, canDockConversations, toggleConversations } =
    useWorkspaceLayout();
  const hub = useChatHubContext();
  const hubOpen = isPersistentLayout && sourcesVisible;
  const hubLabel =
    hub?.desktop.mode === "detached"
      ? "Show Hub window"
      : isPersistentLayout
        ? hubOpen
          ? "Hide sources"
          : "Show sources"
        : "Open Hub";
  const conversationLabel = canDockConversations
    ? conversationsOpen
      ? "Collapse sidebar"
      : "Expand sidebar"
    : conversationsOpen
      ? "Hide sidebar"
      : "Show sidebar";
  return (
    <header
      ref={ref}
      data-testid="chat-header"
      className="sticky top-0 z-10 h-12 min-w-0 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur sm:h-14"
    >
      <div className="flex h-full min-w-0 items-center gap-2 px-3 sm:px-4">
        <Button
          data-conversations-toggle
          aria-label={conversationLabel}
          title={conversationLabel}
          aria-expanded={conversationsOpen}
          className="size-8 shrink-0"
          size="icon-sm"
          variant="ghost"
          onClick={toggleConversations}
        >
          {conversationsOpen ? (
            <PanelLeftClose className="size-4" />
          ) : (
            <PanelLeftOpen className="size-4" />
          )}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-col sm:items-start sm:justify-center sm:gap-0">
          <h1
            className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-foreground sm:w-full sm:flex-none"
            title={threadTitle}
          >
            {threadTitle}
          </h1>
          <ChatWorkContext
            workspaceId={workspaceId}
            threadId={threadId}
            creation={creationContext}
            disabled={creationDisabled}
          />
        </div>
        {presenceSlot && width >= 700 ? (
          <div className="shrink-0">{presenceSlot}</div>
        ) : null}
        <HeaderModelSelector
          {...models}
          compact
          iconOnly={width < 640}
          isLoading={isModelCatalogLoading}
        />
        <Button
          data-hub-toggle
          className="size-8 shrink-0"
          size="icon-sm"
          variant="ghost"
          title={hubLabel}
          aria-label={hubLabel}
          onClick={() => {
            if (hub?.desktop.mode === "detached") {
              void hub.desktop.open();
              return;
            }
            if (hub?.desktop.inlineVisible === false) {
              hub.desktop.showInline();
              if (isPersistentLayout) {
                if (!sourcesVisible) onToggleSources();
              } else onOpenHub();
              return;
            }
            if (isPersistentLayout) onToggleSources();
            else onOpenHub();
          }}
        >
          {hubOpen ? (
            <PanelRightClose className="size-4" />
          ) : (
            <PanelRightOpen className="size-4" />
          )}
        </Button>
      </div>
    </header>
  );
}
