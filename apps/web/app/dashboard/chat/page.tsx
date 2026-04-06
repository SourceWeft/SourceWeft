"use client";

import { useState } from "react";
import {
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Star,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useDashboardChatState } from "../_components/dashboard-chat-state";
import { librarySources } from "./_components/mock-data";
import { ChatCanvas } from "./_components/chat-canvas";
import { SourcesHub } from "./_components/sources-hub";

export default function DashboardChatPage() {
  const {
    createChat,
    mode,
    sourcesVisible,
    startNewChat,
    threadTitle,
    toggleSourcesVisible,
  } = useDashboardChatState();

  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);

  const selectedSources = librarySources.filter((s) =>
    selectedSourceIds.includes(s.id),
  );

  function handleRemoveSource(id: string) {
    setSelectedSourceIds((prev) => prev.filter((x) => x !== id));
  }

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">
              {mode === "thread" ? threadTitle : "New chat"}
            </h1>
            <span className="rounded-full border border-input bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
              Private
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {mode === "thread"
              ? "AI Research Desk · 3 sources in context · Updated just now"
              : "AI Research Desk · Pick a few sources and start a grounded conversation"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" type="button" variant="outline">
            <Star className="h-4 w-4" />
            Save
          </Button>
          <Button onClick={startNewChat} size="sm" type="button">
            <MessageSquareText className="h-4 w-4" />
            New chat
          </Button>
          <Button
            onClick={toggleSourcesVisible}
            size="icon-sm"
            title={sourcesVisible ? "Hide sources" : "Show sources"}
            type="button"
            variant="outline"
          >
            {sourcesVisible ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
            <span className="sr-only">
              {sourcesVisible ? "Hide sources" : "Show sources"}
            </span>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <ChatCanvas
          mode={mode}
          onRemoveSource={handleRemoveSource}
          onSelectThread={(title) => createChat(title)}
          selectedSources={selectedSources}
          sourcesVisible={sourcesVisible}
          threadTitle={threadTitle}
        />
        {sourcesVisible ? (
          <SourcesHub
            mode={mode}
            onSelectionChange={setSelectedSourceIds}
            selectedIds={selectedSourceIds}
          />
        ) : null}
      </div>
    </>
  );
}
