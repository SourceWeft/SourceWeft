"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useDashboardChatState } from "../_components/dashboard-chat-state";
import {
  allModels,
  HeaderModelSelector,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  type ModelAliasSettings,
  type ModelItem,
  type ModelType,
} from "./_components/header-model-selector";
import { ChatCanvas } from "./_components/chat-canvas";
import { SourcesHub } from "./_components/sources-hub";
import type { SourceItem } from "./_components/mock-data";
import { contentClient } from "../../../lib/sdk";

const EMPTY_MODEL_KIND_FLAGS: Record<ModelType, boolean> = {
  llm: false,
  image: false,
  vision: false,
};

export default function DashboardChatPage() {
  const router = useRouter();
  const {
    createChat,
    sourcesVisible,
    toggleSourcesVisible,
    workspaceId,
  } = useDashboardChatState();

  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<
    Record<ModelType, ModelItem>
  >(() => resolveSelectedModels({ availableModels: allModels }));
  const [availableModels, setAvailableModels] = useState<Record<ModelType, ModelItem[]>>(
    allModels,
  );
  const [catalogKindEnabled, setCatalogKindEnabled] = useState<
    Record<ModelType, boolean>
  >(EMPTY_MODEL_KIND_FLAGS);

  useEffect(() => {
    if (!workspaceId) {
      setAvailableModels(allModels);
      setSelectedModels(resolveSelectedModels({ availableModels: allModels }));
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      return;
    }

    const activeWorkspaceId = workspaceId;

    let cancelled = false;

    async function loadModelCatalog() {
      try {
        const catalog = await contentClient.listThreadModelCatalog(activeWorkspaceId);
        if (cancelled) {
          return;
        }

        const catalogModels = mapCatalogKindsToModelItems(catalog.kinds);
        const kindEnabled = {
          llm: catalogModels.llm.length > 0,
          image: catalogModels.image.length > 0,
          vision: catalogModels.vision.length > 0,
        } satisfies Record<ModelType, boolean>;

        setCatalogKindEnabled(kindEnabled);
        setAvailableModels(catalogModels);
        setSelectedModels(
          resolveSelectedModels({
            availableModels: catalogModels,
            fallbackAliases: catalog.defaults,
            fallbackModels: allModels,
          }),
        );
      } catch {
        if (cancelled) {
          return;
        }

        setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
        setAvailableModels(allModels);
        setSelectedModels(resolveSelectedModels({ availableModels: allModels }));
      }
    }

    void loadModelCatalog();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setSelectedSourceIds([]);
      return;
    }

    const raw = window.sessionStorage.getItem(`chat:sources:${workspaceId}:current`);
    if (!raw) {
      setSelectedSourceIds([]);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      setSelectedSourceIds(
        Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === "string")
          : [],
      );
    } catch {
      setSelectedSourceIds([]);
    }
  }, [workspaceId]);

  const selectedSources = librarySources.filter((s) =>
    selectedSourceIds.includes(s.id),
  );

  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!workspaceId) {
        toast.error("No workspace selected yet.");
        return;
      }

      const text = content.trim();
      if (!text) return;

      const modelSettings: ModelAliasSettings = {};
      if (catalogKindEnabled.llm) {
        modelSettings.llmModelAlias = selectedModels.llm.id;
      }
      if (catalogKindEnabled.image) {
        modelSettings.imageModelAlias = selectedModels.image.id;
      }
      if (catalogKindEnabled.vision) {
        modelSettings.visionModelAlias = selectedModels.vision.id;
      }

      const hasModelSettings = Object.keys(modelSettings).length > 0;
      const thread = await createChat({
        title: text.slice(0, 60),
        modelSettings: hasModelSettings ? modelSettings : undefined,
      });
      if (!thread) {
        toast.error("Failed to create conversation.");
        return;
      }

      // Pass the initial message + selected sources to the thread page via
      // session storage (consumed once on mount).
      sessionStorage.setItem(
        `chat:pending:${thread.id}`,
        JSON.stringify({ content: text, sourceIds: selectedSourceIds }),
      );

      router.push(`/dashboard/chat/${thread.id}`);
    },
    [
      workspaceId,
      createChat,
      selectedSourceIds,
      router,
      catalogKindEnabled,
      selectedModels,
    ],
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6 xl:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold text-foreground">
                  New chat
                </h1>
              </div>
              <HeaderModelSelector
                availableModels={availableModels}
                selectedModels={selectedModels}
                setSelectedModels={setSelectedModels}
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
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
          isStreaming={false}
          mode="new"
          onRemoveSource={(id) =>
            setSelectedSourceIds((prev) => prev.filter((x) => x !== id))
          }
          onSendMessage={handleSendMessage}
          selectedSources={selectedSources}
          sourcesVisible={sourcesVisible}
          threadTitle="New chat"
          workspaceId={workspaceId}
        />
      </div>

      {sourcesVisible ? (
        <SourcesHub
          mode="new"
          onSelectionChange={setSelectedSourceIds}
          onSourceLoad={setLibrarySources}
          selectedIds={selectedSourceIds}
          workspaceId={workspaceId}
        />
      ) : null}
    </div>
  );
}
