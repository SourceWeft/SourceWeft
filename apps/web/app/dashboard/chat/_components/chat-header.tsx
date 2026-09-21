"use client";

import type { ComponentProps, ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { cn } from "@sourceweft/ui-web/lib/utils";
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
  /** The sub-agent conversation currently open in the side panel. */
  activeSubagentId?: string | null;
  /**
   * Framed inside a sub-agent panel: the header keeps the title and model
   * selector and drops everything that navigates the framing page.
   */
  embedMode?: boolean;
  onOpenInNewWindow?: () => void;
  onOpenParentThread?: () => void;
  onOpenSubagent?: (threadId: string) => void;
  /** Set for a sub-agent conversation: the chat it nests under. */
  parentThread?: { id: string; title: string } | null;
  /** The sub-agent conversations nested under this thread. */
  subagentChildren?: { id: string; title: string }[];
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
  activeSubagentId = null,
  embedMode = false,
  onOpenInNewWindow,
  onOpenParentThread,
  onOpenSubagent,
  parentThread,
  subagentChildren = [],
  ...models
}: Props) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const {
    conversationsOpen,
    conversationsDocked,
    desktopTitlebar,
    canDockConversations,
    toggleConversations,
  } = useWorkspaceLayout();
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
      data-desktop-drag-region
      className={cn(
        "sticky top-0 z-10 min-w-0 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur",
        desktopTitlebar ? "h-14 select-none" : "h-12 sm:h-14",
      )}
    >
      <div
        className={cn(
          "flex h-full min-w-0 items-center gap-2 pr-3 sm:pr-4",
          desktopTitlebar && !conversationsDocked
            ? "pl-[264px]"
            : "pl-3 sm:pl-4",
        )}
      >
        {embedMode ? null : (
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
        )}
        <div
          className={cn(
            "flex min-w-0 flex-1",
            desktopTitlebar
              ? "flex-col items-start justify-center gap-0"
              : "items-center gap-2 sm:flex-col sm:items-start sm:justify-center sm:gap-0",
          )}
        >
          {parentThread && !embedMode ? (
            <button
              className="flex min-w-0 max-w-full items-center gap-0.5 text-[11px] leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:underline focus-visible:outline-none"
              onClick={onOpenParentThread}
              title={`Back to ${parentThread.title}`}
              type="button"
            >
              <ChevronLeft className="size-3 shrink-0" />
              <span className="truncate">{parentThread.title}</span>
            </button>
          ) : null}
          <h1
            className={cn(
              "min-w-0 truncate text-sm font-semibold leading-5 text-foreground",
              desktopTitlebar
                ? "w-full flex-none"
                : "flex-1 sm:w-full sm:flex-none",
            )}
            title={threadTitle}
          >
            {threadTitle}
          </h1>
          <ChatWorkContext
            workspaceId={workspaceId}
            threadId={threadId}
            creation={creationContext}
            disabled={creationDisabled}
            compact={desktopTitlebar}
          />
        </div>
        {presenceSlot && width >= 700 ? (
          <div className="shrink-0">{presenceSlot}</div>
        ) : null}
        {!embedMode && onOpenSubagent && subagentChildren.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="h-8 shrink-0 gap-1.5 px-2"
                size="sm"
                title="Sub-agents"
                type="button"
                variant="ghost"
              >
                <Bot className="size-4" />
                <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground">
                  {subagentChildren.length}
                </span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {subagentChildren.map((child) => (
                <DropdownMenuItem
                  key={child.id}
                  className={cn(
                    child.id === activeSubagentId && "bg-accent/60",
                  )}
                  onSelect={() => onOpenSubagent(child.id)}
                >
                  <Bot className="size-4" />
                  <span className="truncate">{child.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {parentThread && onOpenInNewWindow && !embedMode ? (
          <Button
            className="size-8 shrink-0"
            onClick={onOpenInNewWindow}
            size="icon-sm"
            title="Open in new window"
            type="button"
            variant="ghost"
          >
            <ExternalLink className="size-4" />
            <span className="sr-only">Open in new window</span>
          </Button>
        ) : null}
        <HeaderModelSelector
          {...models}
          compact={width < 1000}
          iconOnly={width < 640}
          isLoading={isModelCatalogLoading}
        />
        {embedMode ? null : (
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
        )}
      </div>
    </header>
  );
}
