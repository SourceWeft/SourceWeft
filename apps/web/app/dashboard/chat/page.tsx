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
import {
  allModels,
  HeaderModelSelector,
  type ModelItem,
  type ModelType,
} from "./_components/header-model-selector";
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
  const [composerInitialInput, setComposerInitialInput] = useState("");
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [selectedModels, setSelectedModels] = useState<
    Record<ModelType, ModelItem>
  >({
    image: allModels.image[0]!,
    llm: allModels.llm[0]!,
    vision: allModels.vision[0]!,
  });

  const selectedSources = librarySources.filter((s) =>
    selectedSourceIds.includes(s.id),
  );

  function handleRemoveSource(id: string) {
    setSelectedSourceIds((prev) => prev.filter((x) => x !== id));
  }

  function handleCreateChat(title?: string) {
    setComposerInitialInput("");
    setComposerResetKey((value) => value + 1);
    createChat(title);
  }

  function handleStartNewChat() {
    setComposerInitialInput("");
    setComposerResetKey((value) => value + 1);
    startNewChat();
  }

  function handleRestartFromMessage(message: string) {
    setComposerInitialInput(message);
    setComposerResetKey((value) => value + 1);
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6 xl:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold text-foreground">
                  {mode === "thread" ? threadTitle : "New chat"}
                </h1>
              </div>

              <HeaderModelSelector
                selectedModels={selectedModels}
                setSelectedModels={setSelectedModels}
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" type="button" variant="outline">
                <Star className="h-4 w-4" />
                Save
              </Button>
              <Button onClick={handleStartNewChat} size="sm" type="button">
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
          </div>
        </header>

        <ChatCanvas
          composerInitialInput={composerInitialInput}
          composerResetKey={composerResetKey}
          mode={mode}
          onRemoveSource={handleRemoveSource}
          onRestartFromMessage={handleRestartFromMessage}
          onSelectThread={handleCreateChat}
          selectedSources={selectedSources}
          sourcesVisible={sourcesVisible}
          threadTitle={threadTitle}
        />
      </div>

      {sourcesVisible ? (
        <SourcesHub
          mode={mode}
          onSelectionChange={setSelectedSourceIds}
          selectedIds={selectedSourceIds}
        />
      ) : null}
    </div>
  );
}
