"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import dynamic from "next/dynamic";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { SidebarTrigger } from "@sourceweft/ui-web/components/ui/sidebar";
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
  availableModels,
  byokCredentials,
  byokModels,
  byokProviders,
  byokSelections,
  isPersistentLayout,
  isModelCatalogLoading,
  onAddByokModel,
  onByokSelect,
  onModelSelect,
  onOpenHub,
  onToggleSources,
  selectedModels,
  setSelectedModels,
  sourcesVisible,
  threadTitle,
  presenceSlot,
}: {
  availableModels: Record<ModelType, ModelItem[]>;
  byokCredentials: ByokCredentialItem[];
  byokModels: ByokSavedModelItem[];
  byokProviders: ByokProviderOption[];
  byokSelections: Partial<Record<ModelType, ByokModelSelection | null>>;
  isPersistentLayout: boolean;
  isModelCatalogLoading?: boolean;
  onAddByokModel: (input: HeaderAddByokModelInput) => void;
  onByokSelect: (input: HeaderByokSelectInput) => void;
  onModelSelect: (input: { type: ModelType; model: ModelItem }) => void;
  onOpenHub: () => void;
  onToggleSources: () => void;
  selectedModels: SelectedModels;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
  sourcesVisible: boolean;
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
          <div className="shrink-0 md:hidden">
            <SidebarTrigger />
          </div>
          <div className="flex min-w-0 flex-1 items-center md:flex-none">
            <h1 className="truncate text-base leading-none font-semibold text-foreground">
              {threadTitle}
            </h1>
          </div>
          {presenceSlot ? <div className="shrink-0">{presenceSlot}</div> : null}
        </div>

        <div className="contents md:ml-auto md:flex md:h-10 md:shrink-0 md:items-center md:gap-2">
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
        </div>
      </div>
    </header>
  );
}
