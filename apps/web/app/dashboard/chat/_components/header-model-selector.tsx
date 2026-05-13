"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ChevronDown,
  Check,
  Eye,
  Image as ImageIcon,
  KeyRound,
  LockKeyhole,
  Network,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react";
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
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
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
import {
  toByokSelectionFromCatalogModel,
  toByokSelectionFromCustomModel,
  type ByokKeyRefItem,
  type ByokLlmSelection,
  type ByokProviderOption,
} from "./byok-state";

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
  profileAlias?: string | null;
  modelAlias: string;
  name: string;
  logoSrc?: string;
  provider: string;
  subtitle: string;
  badges?: string[];
  capabilities?: ModelThinkingCapabilities;
  availableViaGlobal?: boolean;
  availableViaByokProviders?: string[];
  selectionOrigin?: "catalog" | "custom";
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
  availableViaGlobal?: boolean;
  availableViaByokProviders?: string[];
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

export function normalizeProviderSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "model";
}

export function toProviderLabel(value: string) {
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
    profileAlias: entry.profileAlias,
    modelAlias: entry.modelAlias,
    name,
    logoSrc: isGlobalAutoModel ? SOURCEWEFT_LOGO_SRC : undefined,
    provider: providerSlug,
    subtitle: itemSubtitle,
    badges,
    capabilities: entry.capabilities,
    availableViaGlobal: entry.availableViaGlobal ?? false,
    availableViaByokProviders: entry.availableViaByokProviders ?? [],
    selectionOrigin: "catalog",
  };
}

export function createCustomModelItem(input: {
  capabilities?: ModelThinkingCapabilities | null;
  modelAlias: string;
  name?: string;
  providerLabel: string;
  providerSlug: string;
  subtitle?: string;
}) {
  const modelAlias = input.modelAlias.trim();
  const name = input.name?.trim() || modelAlias;
  return {
    chef: input.providerLabel,
    chefSlug: input.providerSlug,
    id: `custom:${input.providerSlug}:${modelAlias}`,
    profileAlias: null,
    modelAlias,
    name,
    provider: input.providerSlug,
    subtitle: input.subtitle?.trim() || `${input.providerLabel} BYOK`,
    badges: ["BYOK", "Custom"],
    capabilities: input.capabilities ?? undefined,
    availableViaGlobal: false,
    availableViaByokProviders: [input.providerSlug],
    selectionOrigin: "custom",
  } satisfies ModelItem;
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
        (model) =>
          model.id === alias ||
          model.profileAlias === alias ||
          model.modelAlias === alias,
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
      (model) =>
        model.id === alias ||
        model.profileAlias === alias ||
        model.modelAlias === alias,
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

function CatalogModelList({
  models,
  onSelect,
  scrollToSelectedKey,
  selectedModel,
}: {
  models: ModelItem[];
  onSelect: (model: ModelItem) => void;
  scrollToSelectedKey?: string | number | null;
  selectedModel: ModelItem | null;
}) {
  const chefs = [...new Set(models.map((model) => model.chef))];
  const selectedItemRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollToSelectedKey) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      selectedItemRef.current?.scrollIntoView({
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [models.length, scrollToSelectedKey, selectedModel?.id]);

  return (
    <ModelSelectorList className="max-h-[360px] overflow-y-auto">
      <ModelSelectorEmpty>No models available.</ModelSelectorEmpty>
      {chefs.map((chef) => (
        <ModelSelectorGroup heading={chef} key={chef}>
          {models
            .concat()
            .filter((model) => model.chef === chef)
            .map((model) => {
              const selected = selectedModel?.id === model.id;

              return (
                <ModelSelectorItem
                  data-checked={selected ? true : undefined}
                  key={model.id}
                  onSelect={() => onSelect(model)}
                  ref={selected ? selectedItemRef : undefined}
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
      ))}
    </ModelSelectorList>
  );
}

function ByokPanel({
  availableModels,
  byokKeyRefs,
  byokProviders,
  byokSelection,
  onManageByok,
  onSelect,
  scrollToSelectedKey,
  selectedModel,
}: {
  availableModels: Record<ModelType, ModelItem[]>;
  byokKeyRefs: ByokKeyRefItem[];
  byokProviders: ByokProviderOption[];
  byokSelection: ByokLlmSelection | null;
  onManageByok?: () => void;
  onSelect: (input: { model: ModelItem; selection: ByokLlmSelection }) => void;
  scrollToSelectedKey?: string | number | null;
  selectedModel: ModelItem | null;
}) {
  const [providerName, setProviderName] = useState<string>("");
  const [keyRef, setKeyRef] = useState<string>("");
  const [customModelName, setCustomModelName] = useState("");
  const [query, setQuery] = useState("");
  const providerOptions = useMemo(
    () => byokProviders.filter((provider) => provider.hasApiKey),
    [byokProviders],
  );

  useEffect(() => {
    const nextProvider = byokSelection?.providerName?.trim();
    if (nextProvider) {
      setProviderName(nextProvider);
      return;
    }
    if (!providerName && providerOptions[0]) {
      setProviderName(providerOptions[0].providerName);
    }
  }, [byokSelection?.providerName, providerName, providerOptions]);

  useEffect(() => {
    const nextKeyRef = byokSelection?.keyRef?.trim();
    if (nextKeyRef) {
      setKeyRef(nextKeyRef);
      return;
    }
    const firstKey =
      byokKeyRefs.find((item) => item.providerName === providerName)?.keyRef ?? "";
    if (!keyRef || !byokKeyRefs.some((item) => item.providerName === providerName && item.keyRef === keyRef)) {
      setKeyRef(firstKey);
    }
  }, [byokKeyRefs, byokSelection?.keyRef, keyRef, providerName]);

  useEffect(() => {
    if (byokSelection?.source === "custom" && byokSelection.customModelName) {
      setCustomModelName(byokSelection.customModelName);
    }
  }, [byokSelection]);

  const provider = byokProviders.find((item) => item.providerName === providerName) ?? null;
  const providerLabel = provider ? toProviderLabel(provider.providerName) : "BYOK";
  const providerSlug = provider ? normalizeProviderSlug(provider.providerName) : "byok";
  const providerKeyRefs = byokKeyRefs.filter(
    (item) => item.providerName === providerName,
  );
  const knownModels = availableModels.llm.filter((model) =>
    (model.availableViaByokProviders ?? []).includes(providerName),
  );
  const filteredKnownModels = knownModels.filter((model) => {
    const haystack = `${model.name} ${model.subtitle} ${model.modelAlias}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const canCreateCustomModel =
    providerName.trim().length > 0 &&
    keyRef.trim().length > 0 &&
    customModelName.trim().length > 0;

  return (
    <div className="space-y-3 px-2 pt-2 pb-1">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LockKeyhole className="size-3.5 text-muted-foreground" />
            BYOK configuration
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Saved provider, key ref, and model are bundled into the next chat request.
          </div>
        </div>
        <Button onClick={onManageByok} size="sm" type="button" variant="outline">
          <Plus className="mr-2 size-3.5" />
          Manage
        </Button>
      </div>

      {providerOptions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-3 py-6 text-sm text-muted-foreground">
          No saved BYOK providers yet. Add a key to start using BYOK models.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(170px,0.78fr)_minmax(0,1.22fr)]">
          <section className="space-y-3 rounded-lg border border-border/70 bg-background p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Network className="size-3.5 text-muted-foreground" />
              Provider
            </div>
            <div className="max-h-[188px] space-y-1.5 overflow-y-auto pr-1">
              {providerOptions.map((item) => {
                const selected = item.providerName === providerName;
                return (
                  <button
                    className={
                      selected
                        ? "flex w-full items-center justify-between gap-2 rounded-md border border-foreground bg-foreground px-2.5 py-2 text-left text-xs font-medium text-background"
                        : "flex w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/10 px-2.5 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/40"
                    }
                    key={item.providerName}
                    onClick={() => setProviderName(item.providerName)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">
                        {toProviderLabel(item.providerName)}
                      </span>
                      <span
                        className={
                          selected
                            ? "block truncate text-[10px] text-background/70"
                            : "block truncate text-[10px] text-muted-foreground"
                        }
                      >
                        {item.system ? "System provider" : "Custom provider"}
                      </span>
                    </span>
                    {selected ? <Check className="size-3.5 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>

            <div className="space-y-2 border-t border-border/70 pt-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-foreground">
                  Saved key
                </div>
                {provider?.baseUrl ? (
                  <span className="max-w-[132px] truncate text-[10px] text-muted-foreground">
                    {provider.baseUrl}
                  </span>
                ) : null}
              </div>
              {providerKeyRefs.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/15 px-3 py-3 text-xs text-muted-foreground">
                  No saved key found for {providerLabel}. Add one from Manage.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {providerKeyRefs.map((item) => {
                    const selected = item.keyRef === keyRef;
                    return (
                      <button
                        className={
                          selected
                            ? "flex w-full items-center justify-between gap-2 rounded-md border border-foreground bg-foreground px-2.5 py-2 text-left text-xs font-medium text-background"
                            : "flex w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-2.5 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/40"
                        }
                        key={item.id}
                        onClick={() => setKeyRef(item.keyRef)}
                        type="button"
                      >
                        <span className="truncate">{item.keyRef}</span>
                        {selected ? <Check className="size-3.5 shrink-0" /> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="min-w-0 rounded-lg border border-border/70 bg-background p-3">
            <Tabs className="w-full gap-0" defaultValue="known">
              <TabsList className="grid h-9 w-full grid-cols-2">
                <TabsTrigger value="known">
                  <Sparkles className="mr-1.5 size-3.5" />
                  Catalog
                </TabsTrigger>
                <TabsTrigger value="custom">
                  <KeyRound className="mr-1.5 size-3.5" />
                  Custom
                </TabsTrigger>
              </TabsList>

              <TabsContent className="mt-3 space-y-3" value="known">
                <Input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search BYOK-ready models..."
                  value={query}
                />
                <CatalogModelList
                  models={filteredKnownModels}
                  onSelect={(model) => {
                    if (!providerName || !keyRef) {
                      return;
                    }
                    const selection = toByokSelectionFromCatalogModel({
                      capabilities: model.capabilities,
                      keyRef,
                      modelAlias: model.modelAlias,
                      profileAlias: model.profileAlias ?? model.id,
                      providerName,
                    });
                    if (!selection) {
                      return;
                    }
                    onSelect({ model, selection });
                  }}
                  scrollToSelectedKey={scrollToSelectedKey}
                  selectedModel={
                    byokSelection?.source === "catalog" ? selectedModel : null
                  }
                />
                {filteredKnownModels.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border/70 bg-muted/15 px-3 py-4 text-xs text-muted-foreground">
                    No catalog models are marked as available for {providerLabel}. You can still use a custom model name.
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent className="mt-3 space-y-3" value="custom">
                <div className="rounded-lg border border-border/70 bg-muted/10 p-3">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-foreground">
                      Raw model name
                    </div>
                    <Input
                      onChange={(event) => setCustomModelName(event.target.value)}
                      placeholder="gpt-4.1-mini or my-vllm-model"
                      value={customModelName}
                    />
                    <div className="text-xs text-muted-foreground">
                      Custom models use the selected provider and key ref. Known catalog models keep richer capability metadata.
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      disabled={!canCreateCustomModel}
                      onClick={() => {
                        if (!providerName || !keyRef || !customModelName.trim()) {
                          return;
                        }
                        const selection = toByokSelectionFromCustomModel({
                          capabilities: null,
                          keyRef,
                          modelName: customModelName,
                          providerName,
                        });
                        const model = createCustomModelItem({
                          modelAlias: customModelName.trim(),
                          name: customModelName.trim(),
                          providerLabel,
                          providerSlug,
                          subtitle: `${providerLabel} custom BYOK`,
                        });
                        onSelect({ model, selection });
                      }}
                      size="sm"
                      type="button"
                    >
                      Use custom model
                    </Button>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </section>
        </div>
      )}
    </div>
  );
}

function SelectorPanel({
  activeTab,
  availableModels,
  byokKeyRefs,
  byokProviders,
  byokSelection,
  onByokSelect,
  onManageByok,
  onModelSelect,
  selectedModels,
  setActiveTab,
  setOpen,
  setSelectedModels,
  scrollToSelectedKey,
}: {
  activeTab: ModelType;
  availableModels: Record<ModelType, ModelItem[]>;
  byokKeyRefs?: ByokKeyRefItem[];
  byokProviders?: ByokProviderOption[];
  byokSelection?: ByokLlmSelection | null;
  onByokSelect?: (input: { model: ModelItem; selection: ByokLlmSelection }) => void;
  onManageByok?: () => void;
  onModelSelect?: (input: { type: ModelType; model: ModelItem }) => void;
  selectedModels: SelectedModels;
  setActiveTab: Dispatch<SetStateAction<ModelType>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
  scrollToSelectedKey?: number;
}) {
  const [llmMode, setLlmMode] = useState<"global" | "byok">(
    byokSelection?.mode === "byok" ? "byok" : "global",
  );

  useEffect(() => {
    if (byokSelection?.mode === "byok") {
      setLlmMode("byok");
    }
  }, [byokSelection?.mode]);

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
          {type === "llm" ? (
            <div className="px-2 pt-2 pb-1.5">
              <Tabs
                className="w-full gap-0"
                onValueChange={(value) => setLlmMode(value as "global" | "byok")}
                value={llmMode}
              >
                <TabsList className="grid h-10 w-full grid-cols-2">
                  <TabsTrigger value="global">Global</TabsTrigger>
                  <TabsTrigger value="byok">BYOK</TabsTrigger>
                </TabsList>
                <TabsContent className="mt-0" value="global">
                  <div className="px-0 pt-2.5 pb-1.5">
                    <ModelSelectorInput placeholder="Search models..." />
                  </div>
                  <CatalogModelList
                    models={availableModels[type] ?? []}
                    onSelect={(model) => {
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
                    scrollToSelectedKey={
                      llmMode === "global"
                        ? `${scrollToSelectedKey}:llm:global`
                        : null
                    }
                    selectedModel={selectedModels[type]}
                  />
                </TabsContent>
                <TabsContent className="mt-0" value="byok">
                  <ByokPanel
                    availableModels={availableModels}
                    byokKeyRefs={byokKeyRefs ?? []}
                    byokProviders={byokProviders ?? []}
                    byokSelection={byokSelection ?? null}
                    onManageByok={onManageByok}
                    onSelect={({ model, selection }) => {
                      setSelectedModels((current) => ({
                        ...current,
                        llm: model,
                      }));
                      onByokSelect?.({ model, selection });
                      setOpen(false);
                    }}
                    scrollToSelectedKey={
                      byokSelection?.source === "catalog" && llmMode === "byok"
                        ? `${scrollToSelectedKey}:llm:byok`
                        : null
                    }
                    selectedModel={selectedModels.llm}
                  />
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <>
              <div className="px-2 pt-2.5 pb-1.5">
                <ModelSelectorInput placeholder="Search models..." />
              </div>
              <CatalogModelList
                models={availableModels[type] ?? []}
                onSelect={(model) => {
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
                scrollToSelectedKey={`${scrollToSelectedKey}:${type}`}
                selectedModel={selectedModels[type]}
              />
            </>
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function HeaderModelSelector({
  availableModels = emptyModelCatalog,
  byokKeyRefs = [],
  byokProviders = [],
  byokSelection = null,
  onByokSelect,
  onManageByok,
  onModelSelect,
  selectedModels,
  setSelectedModels,
}: {
  availableModels?: Record<ModelType, ModelItem[]>;
  byokKeyRefs?: ByokKeyRefItem[];
  byokProviders?: ByokProviderOption[];
  byokSelection?: ByokLlmSelection | null;
  onByokSelect?: (input: { model: ModelItem; selection: ByokLlmSelection }) => void;
  onManageByok?: () => void;
  onModelSelect?: (input: { type: ModelType; model: ModelItem }) => void;
  selectedModels: SelectedModels;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ModelType>("llm");
  const [openSequence, setOpenSequence] = useState(0);
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setOpenSequence((current) => current + 1);
    }
  };

  return (
    <ModelSelector onOpenChange={handleOpenChange} open={open}>
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-background px-1 py-0.5 shadow-xs">
          {(["llm", "image", "vision"] as ModelType[]).map((type) => {
            const model = selectedModels[type] ?? availableModels[type]?.[0] ?? null;
            const showByokBadge = type === "llm" && byokSelection?.mode === "byok";

            return (
              <Tooltip key={type}>
                <TooltipTrigger asChild>
                  <ModelSelectorTrigger asChild>
                    <button
                      className="flex min-w-0 max-w-[152px] items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 aria-expanded:bg-muted/50"
                      onClick={() => setActiveTab(type)}
                      type="button"
                    >
                      <div className="flex size-5.5 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/35 text-muted-foreground">
                        <ModelTypeIcon type={type} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={
                            model
                              ? "truncate text-[11px] leading-4 font-medium text-foreground"
                              : "truncate text-[11px] leading-4 font-medium text-muted-foreground"
                          }
                        >
                          {model?.name ?? `No ${modelTypeLabels[type]}`}
                        </div>
                        {showByokBadge ? (
                          <div className="mt-0.5 flex items-center gap-1 text-[9px] leading-3 text-muted-foreground">
                            <KeyRound className="size-2.5" />
                            BYOK
                          </div>
                        ) : null}
                      </div>
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  </ModelSelectorTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {type === "llm" && byokSelection?.mode === "byok"
                    ? `LLM: ${model?.name ?? "BYOK"} via ${byokSelection.providerName ?? "BYOK"}`
                    : model
                      ? `${modelTypeLabels[type]}: ${model.name}`
                      : `No ${modelTypeLabels[type]} model available`}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>

      <ModelSelectorContent className="max-w-[92vw] sm:max-w-[520px]" title="Select model">
        <SelectorPanel
          activeTab={activeTab}
          availableModels={availableModels}
          byokKeyRefs={byokKeyRefs}
          byokProviders={byokProviders}
          byokSelection={byokSelection}
          onByokSelect={onByokSelect}
          onManageByok={onManageByok}
          onModelSelect={onModelSelect}
          selectedModels={selectedModels}
          scrollToSelectedKey={openSequence}
          setActiveTab={setActiveTab}
          setOpen={setOpen}
          setSelectedModels={setSelectedModels}
        />
      </ModelSelectorContent>
    </ModelSelector>
  );
}
