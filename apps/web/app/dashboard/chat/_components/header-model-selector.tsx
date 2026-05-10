"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { ChevronDown, Eye, Image as ImageIcon, Zap } from "lucide-react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@sourceweft/ui-web/components/ai-elements/model-selector";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sourceweft/ui-web/components/ui/tooltip";

export type ModelType = "llm" | "image" | "vision";

export type ModelThinkingCapabilities = {
  supportsThinking: boolean;
  supportedParameters?: string[];
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  reasoning?: boolean;
  reasoningEffort?: boolean;
  includeReasoning?: boolean;
  supportSources?: string[];
  imageGeneration?: {
    supported: boolean;
    provider?: string;
    controls?: {
      aspectRatio?: {
        values: Array<
          | "auto"
          | "1:1"
          | "2:3"
          | "3:2"
          | "3:4"
          | "4:3"
          | "4:5"
          | "5:4"
          | "9:16"
          | "16:9"
          | "21:9"
          | "1:4"
          | "4:1"
          | "1:8"
          | "8:1"
        >;
      };
      quality?: {
        values: Array<"auto" | "low" | "standard" | "higher" | "highest">;
      };
      style?: {
        values: Array<"auto" | "ghibli" | "pixar" | "cartoon" | "pixel">;
      };
    };
  };
};

export type ModelItem = {
  chef: string;
  chefSlug: string;
  id: string;
  modelAlias: string;
  name: string;
  logoSrc?: string;
  provider: string;
  subtitle: string;
  badges?: string[];
  capabilities?: ModelThinkingCapabilities;
};

export type ModelAliasSettings = {
  llmProfileAlias?: string | null;
  imageProfileAlias?: string | null;
  visionProfileAlias?: string | null;
  llmModelAlias?: string | null;
  imageModelAlias?: string | null;
  visionModelAlias?: string | null;
};

export type SelectedModels = Record<ModelType, ModelItem | null>;

type CatalogModelEntry = {
  profileAlias: string;
  modelAlias: string;
  displayName: string;
  subtitle: string;
  badges: string[];
  providerName?: string | null;
  providerKind?: string | null;
  targetModel?: string | null;
  capabilities?: ModelThinkingCapabilities;
};

type CatalogModelKinds = {
  llm: CatalogModelEntry[];
  image: CatalogModelEntry[];
  vision: CatalogModelEntry[];
};

export const emptyModelCatalog: Record<ModelType, ModelItem[]> = {
  image: [],
  llm: [],
  vision: [],
};

function normalizeProviderSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "model";
}

function toProviderLabel(value: string) {
  const label = value
    .trim()
    .split(/[-_\s/]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return label.length > 0 ? label : "Models";
}

const GLOBAL_AUTO_MODEL_ALIASES = new Set([
  "chat-default",
  "image-default",
  "vision-default",
]);

const SOURCEWEFT_LOGO_SRC = "/logo.svg";

function isInternalOpenRouterAlias(alias: string) {
  return alias.startsWith("global-openrouter-");
}

function deriveDisplayNameFromAlias(alias: string) {
  const modelPart = alias.replace(/^global-openrouter-(chat|image|vision):/, "");
  if (!modelPart || modelPart === alias) {
    return alias;
  }
  const tail = modelPart.split("/").at(-1) ?? modelPart;
  return tail;
}

function mapCatalogEntryToModelItem(entry: CatalogModelEntry): ModelItem {
  const isGlobalAutoModel = GLOBAL_AUTO_MODEL_ALIASES.has(entry.profileAlias);
  const rawProvider =
    entry.providerName?.trim() ||
    entry.providerKind?.trim() ||
    (isInternalOpenRouterAlias(entry.modelAlias) ? "openrouter" : "");
  const providerSlug = isGlobalAutoModel
    ? "sourceweft"
    : normalizeProviderSlug(rawProvider);
  const providerLabel = isGlobalAutoModel
    ? "Global models"
    : toProviderLabel(rawProvider);
  const displayName = entry.displayName.trim() || entry.modelAlias;
  const subtitle =
    entry.subtitle.trim() || entry.targetModel?.trim() || entry.modelAlias;
  const name = isGlobalAutoModel
    ? "Auto (Default)"
    : displayName === entry.modelAlias && isInternalOpenRouterAlias(entry.modelAlias)
      ? subtitle !== entry.modelAlias
        ? subtitle
        : deriveDisplayNameFromAlias(entry.modelAlias)
      : displayName;
  const itemSubtitle = isGlobalAutoModel ? "Global models" : subtitle;

  const badges = Array.from(
    new Set([
      ...(entry.badges ?? []),
      ...(entry.capabilities?.supportsThinking ? ["Thinking"] : []),
      ...(entry.capabilities?.imageGeneration?.supported ? ["Image"] : []),
    ]),
  );

  return {
    chef: providerLabel,
    chefSlug: providerSlug,
    id: entry.profileAlias,
    modelAlias: entry.modelAlias,
    name,
    logoSrc: isGlobalAutoModel ? SOURCEWEFT_LOGO_SRC : undefined,
    provider: providerSlug,
    subtitle: itemSubtitle,
    badges,
    capabilities: entry.capabilities,
  };
}

export function mapCatalogKindsToModelItems(
  kinds: CatalogModelKinds,
): Record<ModelType, ModelItem[]> {
  return {
    llm: kinds.llm.map(mapCatalogEntryToModelItem),
    image: kinds.image.map(mapCatalogEntryToModelItem),
    vision: kinds.vision.map(mapCatalogEntryToModelItem),
  };
}

function resolveAliasesForType(type: ModelType, aliases?: ModelAliasSettings) {
  if (!aliases) {
    return [];
  }

  if (type === "llm") {
    return [aliases.llmProfileAlias, aliases.llmModelAlias].filter(
      (alias): alias is string => typeof alias === "string" && alias.length > 0,
    );
  }
  if (type === "image") {
    return [aliases.imageProfileAlias, aliases.imageModelAlias].filter(
      (alias): alias is string => typeof alias === "string" && alias.length > 0,
    );
  }

  return [aliases.visionProfileAlias, aliases.visionModelAlias].filter(
    (alias): alias is string => typeof alias === "string" && alias.length > 0,
  );
}

function pickSelectedModelForType(input: {
  type: ModelType;
  availableModels: Record<ModelType, ModelItem[]>;
  threadAliases?: ModelAliasSettings;
  fallbackAliases?: ModelAliasSettings;
}) {
  const kindModels = input.availableModels[input.type];

  const resolveByAliases = (aliases: string[]) => {
    for (const alias of aliases) {
      const match = kindModels.find(
        (model) => model.id === alias || model.modelAlias === alias,
      );
      if (match) {
        return match;
      }
    }
    return null;
  };

  const fromThread = resolveByAliases(
    resolveAliasesForType(input.type, input.threadAliases),
  );
  if (fromThread) {
    return fromThread;
  }

  const fromDefaults = resolveByAliases(
    resolveAliasesForType(input.type, input.fallbackAliases),
  );
  if (fromDefaults) {
    return fromDefaults;
  }

  return kindModels[0] ?? null;
}

export function resolveSelectedModels(input: {
  availableModels: Record<ModelType, ModelItem[]>;
  threadAliases?: ModelAliasSettings;
  fallbackAliases?: ModelAliasSettings;
}): SelectedModels {
  return {
    llm: pickSelectedModelForType({
      ...input,
      type: "llm",
    }),
    image: pickSelectedModelForType({
      ...input,
      type: "image",
    }),
    vision: pickSelectedModelForType({
      ...input,
      type: "vision",
    }),
  };
}

export function findModelItemByAlias(input: {
  availableModels: Record<ModelType, ModelItem[]>;
  type: ModelType;
  alias?: string | null;
}) {
  const alias = input.alias?.trim();
  if (!alias) {
    return null;
  }
  return (
    input.availableModels[input.type].find(
      (model) => model.id === alias || model.modelAlias === alias,
    ) ?? null
  );
}

const modelTypeLabels: Record<ModelType, string> = {
  image: "Image",
  llm: "LLM",
  vision: "Vision",
};

function ModelTypeIcon({ type }: { type: ModelType }) {
  if (type === "llm") {
    return <Zap className="size-3.5" />;
  }
  if (type === "image") {
    return <ImageIcon className="size-3.5" />;
  }
  return <Eye className="size-3.5" />;
}

function SelectorPanel({
  activeTab,
  availableModels,
  onModelSelect,
  selectedModels,
  setActiveTab,
  setOpen,
  setSelectedModels,
}: {
  activeTab: ModelType;
  availableModels: Record<ModelType, ModelItem[]>;
  onModelSelect?: (input: { type: ModelType; model: ModelItem }) => void;
  selectedModels: SelectedModels;
  setActiveTab: Dispatch<SetStateAction<ModelType>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
}) {
  return (
    <Tabs
      className="w-full gap-0"
      onValueChange={(value) => setActiveTab(value as ModelType)}
      value={activeTab}
    >
      <div>
        <TabsList
          className="grid h-11 w-full grid-cols-3 rounded-none bg-transparent px-1 pt-1"
          variant="line"
        >
          {(["llm", "image", "vision"] as ModelType[]).map((type) => (
            <TabsTrigger
              className="h-full rounded-t-md border-b border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground data-active:border-foreground data-active:bg-transparent data-active:text-foreground data-active:shadow-none"
              key={type}
              value={type}
            >
              <ModelTypeIcon type={type} />
              {modelTypeLabels[type]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {(["llm", "image", "vision"] as ModelType[]).map((type) => (
        <TabsContent className="mt-0" key={type} value={type}>
          <div className="px-2 pt-2.5 pb-1.5">
            <ModelSelectorInput placeholder="Search models..." />
          </div>
          <ModelSelectorList className="max-h-[360px] overflow-y-auto">
            <ModelSelectorEmpty>No models available.</ModelSelectorEmpty>
            {(() => {
              const modelsForType = availableModels[type] ?? [];
              const chefs = [
                ...new Set(modelsForType.map((model) => model.chef)),
              ];

              return chefs.map((chef) => (
                <ModelSelectorGroup heading={chef} key={chef}>
                  {modelsForType
                    .concat()
                    .filter((model) => model.chef === chef)
                    .map((model) => {
                      const selected = selectedModels[type]?.id === model.id;

                      return (
                        <ModelSelectorItem
                          data-checked={selected ? true : undefined}
                          key={model.id}
                          onSelect={() => {
                            setSelectedModels((current) => ({
                              ...current,
                              [type]: model,
                            }));
                            onModelSelect?.({
                              type,
                              model,
                            });
                            setOpen(false);
                          }}
                          value={`${model.id} ${model.name} ${model.subtitle} ${model.provider} ${model.chef}`}
                        >
                          <ModelSelectorLogo
                            provider={model.chefSlug}
                            src={model.logoSrc}
                          />
                          <ModelSelectorName>{model.name}</ModelSelectorName>
                          {model.badges?.map((badge) => (
                            <Badge
                              className="h-4 rounded-md px-1.5 text-[9px]"
                              key={badge}
                              variant="outline"
                            >
                              {badge}
                            </Badge>
                          ))}
                        </ModelSelectorItem>
                      );
                    })}
                </ModelSelectorGroup>
              ));
            })()}
          </ModelSelectorList>
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function HeaderModelSelector({
  availableModels = emptyModelCatalog,
  onModelSelect,
  selectedModels,
  setSelectedModels,
}: {
  availableModels?: Record<ModelType, ModelItem[]>;
  onModelSelect?: (input: { type: ModelType; model: ModelItem }) => void;
  selectedModels: SelectedModels;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ModelType>("llm");

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-background px-1 py-0.5 shadow-xs">
          {(["llm", "image", "vision"] as ModelType[]).map((type) => {
            const model = selectedModels[type] ?? availableModels[type]?.[0] ?? null;

            return (
              <Tooltip key={type}>
                <TooltipTrigger asChild>
                  <ModelSelectorTrigger asChild>
                    <button
                      className="flex min-w-0 max-w-[136px] items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 aria-expanded:bg-muted/50"
                      onClick={() => setActiveTab(type)}
                      type="button"
                    >
                      <div className="flex size-5.5 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/35 text-muted-foreground">
                        <ModelTypeIcon type={type} />
                      </div>
                      <div
                        className={
                          model
                            ? "min-w-0 flex-1 truncate text-[11px] leading-4 font-medium text-foreground"
                            : "min-w-0 flex-1 truncate text-[11px] leading-4 font-medium text-muted-foreground"
                        }
                      >
                        {model?.name ?? `No ${modelTypeLabels[type]}`}
                      </div>
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  </ModelSelectorTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {model
                    ? `${modelTypeLabels[type]}: ${model.name}`
                    : `No ${modelTypeLabels[type]} model available`}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>

      <ModelSelectorContent className="max-w-[92vw] sm:max-w-[460px]" title="Select model">
        <SelectorPanel
          activeTab={activeTab}
          availableModels={availableModels}
          onModelSelect={onModelSelect}
          selectedModels={selectedModels}
          setActiveTab={setActiveTab}
          setOpen={setOpen}
          setSelectedModels={setSelectedModels}
        />
      </ModelSelectorContent>
    </ModelSelector>
  );
}
