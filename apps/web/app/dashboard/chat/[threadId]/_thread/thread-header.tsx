"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import dynamic from "next/dynamic";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
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
import { SidebarTrigger } from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type {
  ByokCredentialItem,
  ByokModelSelection,
  ByokProviderOption,
  ByokSavedModelItem,
} from "../../_components/byok-state";
import type {
  ModelItem,
  ModelType,
  SelectedModels,
} from "../../_components/model-catalog-utils";

const HeaderModelSelector = dynamic(
  () =>
    import("../../_components/header-model-selector").then(
      (mod) => mod.HeaderModelSelector,
    ),
  {
    loading: () => (
      <div className="h-10 w-36 shrink-0 animate-pulse rounded-md bg-muted" />
    ),
    ssr: false,
  },
);

type HeaderByokSelectInput = {
  model: ModelItem;
  selection: ByokModelSelection;
  type: ModelType;
};

type HeaderAddByokModelInput = {
  credentialId?: string;
  providerKind?: string;
  providerName?: string;
  type: ModelType;
};

export function ThreadHeader({
  activeSubagentId = null,
  availableModels,
  byokCredentials,
  byokModels,
  byokProviders,
  byokSelections,
  embedMode = false,
  isPersistentLayout,
  isModelCatalogLoading,
  onAddByokModel,
  onByokSelect,
  onModelSelect,
  onOpenHub,
  onOpenInNewWindow,
  onOpenParentThread,
  onOpenSubagent,
  onToggleSources,
  parentThread,
  selectedModels,
  setSelectedModels,
  sourcesVisible,
  subagentChildren = [],
  threadTitle,
  presenceSlot,
}: {
  /** The sub-agent conversation currently open in the side panel. */
  activeSubagentId?: string | null;
  availableModels: Record<ModelType, ModelItem[]>;
  byokCredentials: ByokCredentialItem[];
  byokModels: ByokSavedModelItem[];
  byokProviders: ByokProviderOption[];
  byokSelections: Partial<Record<ModelType, ByokModelSelection | null>>;
  /**
   * Framed inside a sub-agent panel: the header keeps the title and model
   * selector and drops everything that navigates the framing page.
   */
  embedMode?: boolean;
  isPersistentLayout: boolean;
  isModelCatalogLoading?: boolean;
  onAddByokModel: (input: HeaderAddByokModelInput) => void;
  onByokSelect: (input: HeaderByokSelectInput) => void;
  onModelSelect: (input: { type: ModelType; model: ModelItem }) => void;
  onOpenHub: () => void;
  onOpenInNewWindow?: () => void;
  onOpenParentThread?: () => void;
  onOpenSubagent?: (threadId: string) => void;
  onToggleSources: () => void;
  /** Set for a sub-agent conversation: the chat it nests under. */
  parentThread?: { id: string; title: string } | null;
  selectedModels: SelectedModels;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
  sourcesVisible: boolean;
  /** The sub-agent conversations nested under this thread. */
  subagentChildren?: { id: string; title: string }[];
  threadTitle: string;
  presenceSlot?: ReactNode;
}) {
  const hubButtonTitle = isPersistentLayout
    ? sourcesVisible
      ? "Hide sources"
      : "Show sources"
    : "Open Hub";

  return (
    <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
      <div className="flex min-h-16 flex-wrap items-start justify-between gap-2 px-3 py-2 md:h-16 md:flex-nowrap md:items-center md:gap-3 md:px-6 md:py-0 xl:px-8">
        <div className="flex min-w-0 flex-1 self-stretch items-center gap-2 overflow-hidden md:gap-2.5">
          {embedMode ? null : (
            <div className="shrink-0 md:hidden">
              <SidebarTrigger />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 md:flex-none">
            {parentThread && !embedMode ? (
              <button
                className="flex min-w-0 items-center gap-0.5 text-[11px] leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline"
                onClick={onOpenParentThread}
                title={`Back to ${parentThread.title}`}
                type="button"
              >
                <ChevronLeft className="size-3 shrink-0" />
                <span className="truncate">{parentThread.title}</span>
              </button>
            ) : null}
            <h1 className="truncate text-base leading-none font-semibold text-foreground">
              {threadTitle}
            </h1>
          </div>
          {presenceSlot ? <div className="shrink-0">{presenceSlot}</div> : null}
        </div>

        <div className="contents md:ml-auto md:flex md:h-10 md:shrink-0 md:items-center md:gap-2">
          {!embedMode && onOpenSubagent && subagentChildren.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="h-8 gap-1.5 px-2.5 md:h-10 md:border-border/60 md:bg-background md:shadow-xs"
                  size="sm"
                  title="Sub-agents"
                  type="button"
                  variant="outline"
                >
                  <Bot className="h-4 w-4" />
                  <span className="hidden text-sm md:inline">Sub-agents</span>
                  <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground">
                    {subagentChildren.length}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
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
              className="size-8 md:h-10 md:w-10 md:border-border/60 md:bg-background md:shadow-xs"
              onClick={onOpenInNewWindow}
              size="icon-sm"
              title="Open in new window"
              type="button"
              variant="outline"
            >
              <ExternalLink className="h-4 w-4" />
              <span className="sr-only">Open in new window</span>
            </Button>
          ) : null}
          <HeaderModelSelector
            availableModels={availableModels}
            byokCredentials={byokCredentials}
            byokModels={byokModels}
            byokProviders={byokProviders}
            byokSelections={byokSelections}
            isLoading={isModelCatalogLoading}
            onAddByokModel={onAddByokModel}
            onByokSelect={onByokSelect}
            onModelSelect={onModelSelect}
            selectedModels={selectedModels}
            setSelectedModels={setSelectedModels}
          />
          {embedMode ? null : (
            <Button
              className="size-8 md:h-10 md:w-10 md:border-border/60 md:bg-background md:shadow-xs"
              onClick={() => {
                if (isPersistentLayout) {
                  onToggleSources();
                  return;
                }
                onOpenHub();
              }}
              size="icon-sm"
              title={hubButtonTitle}
              type="button"
              variant="outline"
            >
              {isPersistentLayout && sourcesVisible ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
              <span className="sr-only">{hubButtonTitle}</span>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
