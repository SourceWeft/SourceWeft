"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslations } from "next-intl";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  ChevronDown,
  Eye,
  Image as ImageIcon,
  KeyRound,
  Plus,
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
  DEFAULT_BYOK_PROVIDER_KIND,
  toByokSelectionFromCustomModel,
  type ByokCredentialItem,
  type ByokModelSelection,
  type ByokProviderOption,
  type ByokSavedModelItem,
} from "./byok-state";
import { catalogProviderLabel } from "./model-catalog-utils";

export type ModelType = "llm" | "image" | "vision";

export type ModelThinkingCapabilities = {
  supportsThinking: boolean;
  supportsImageInput?: boolean;
  supportedParameters?: string[];
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  reasoning?: boolean;
  reasoningEffort?: boolean;
  includeReasoning?: boolean;
  supportSources?: string[];
  maxCompletionTokens?: number | null;
  litellmKey?: string;
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
  byokModelId?: string | null;
  byokCredentialId?: string | null;
  byokCredentialAlias?: string | null;
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
  providerDisplayName?: string | null;
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
  const modelPart = alias.replace(
    /^global-openrouter-(chat|image|vision):/,
    "",
  );
  if (!modelPart || modelPart === alias) {
    return alias;
  }
  const tail = modelPart.split("/").at(-1) ?? modelPart;
  return tail;
}

function mapCatalogEntryToModelItem(
  entry: CatalogModelEntry,
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
): ModelItem {
  const isGlobalAutoModel = GLOBAL_AUTO_MODEL_ALIASES.has(entry.profileAlias);
  const rawProvider =
    entry.providerName?.trim() ||
    entry.providerKind?.trim() ||
    (isInternalOpenRouterAlias(entry.modelAlias) ? "openrouter" : "");
  const providerSlug = isGlobalAutoModel
    ? "sourceweft"
    : normalizeProviderSlug(rawProvider);
  const providerLabel = isGlobalAutoModel
    ? t("modelSelector.globalModels")
    : catalogProviderLabel(entry.providerDisplayName, rawProvider);
  const displayName = entry.displayName.trim() || entry.modelAlias;
  const subtitle =
    entry.subtitle.trim() || entry.targetModel?.trim() || entry.modelAlias;
  const name = isGlobalAutoModel
    ? t("modelSelector.autoDefault")
    : displayName === entry.modelAlias &&
        isInternalOpenRouterAlias(entry.modelAlias)
      ? subtitle !== entry.modelAlias
        ? subtitle
        : deriveDisplayNameFromAlias(entry.modelAlias)
      : displayName;
  const itemSubtitle = isGlobalAutoModel
    ? t("modelSelector.globalModels")
    : subtitle;

  const badges = Array.from(
    new Set([
      ...(entry.badges ?? []),
      ...(entry.capabilities?.supportsThinking ? [t("composer.thinking")] : []),
      ...(entry.capabilities?.imageGeneration?.supported
        ? [t("modelSelector.type.image")]
        : []),
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

export function createCustomModelItem(
  input: {
    byokCredentialId?: string | null;
    byokModelId?: string | null;
    capabilities?: ModelThinkingCapabilities | null;
    modelAlias: string;
    name?: string;
    byokCredentialAlias?: string | null;
    providerLabel: string;
    providerSlug: string;
    subtitle?: string;
  },
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
) {
  const modelAlias = input.modelAlias.trim();
  const name = input.name?.trim() || modelAlias;
  const byokCredentialAlias = input.byokCredentialAlias?.trim() || null;
  const identityParts = [
    "custom",
    input.providerSlug,
    byokCredentialAlias,
    modelAlias,
  ]
    .filter((part): part is string => Boolean(part))
    .join(":");
  return {
    chef: input.providerLabel,
    chefSlug: input.providerSlug,
    id: identityParts,
    profileAlias: null,
    modelAlias,
    name,
    provider: input.providerSlug,
    subtitle:
      input.subtitle?.trim() ||
      t("modelSelector.byok.providerBadge", { provider: input.providerLabel }),
    byokCredentialId: input.byokCredentialId ?? null,
    byokCredentialAlias,
    byokModelId: input.byokModelId ?? null,
    badges: [t("modelSelector.byokTab"), t("modelSelector.byok.custom")],
    capabilities: input.capabilities ?? undefined,
    availableViaGlobal: false,
    availableViaByokProviders: [input.providerSlug],
    selectionOrigin: "custom",
  } satisfies ModelItem;
}

export function mapCatalogKindsToModelItems(
  kinds: CatalogModelKinds,
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
): Record<ModelType, ModelItem[]> {
  return {
    llm: kinds.llm.map((entry) => mapCatalogEntryToModelItem(entry, t)),
    image: kinds.image.map((entry) => mapCatalogEntryToModelItem(entry, t)),
    vision: kinds.vision.map((entry) => mapCatalogEntryToModelItem(entry, t)),
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

function modelTypeLabel(
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
  type: ModelType,
) {
  return t(`modelSelector.type.${type}`);
}

const CUSTOM_BYOK_PROVIDER_NAME = "custom";

function getByokProviderLabel(
  providerName: string,
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
) {
  return providerName === CUSTOM_BYOK_PROVIDER_NAME
    ? t("modelSelector.byok.customProvider")
    : toProviderLabel(providerName);
}

function getByokProviderLogoSlug(providerName: string) {
  return providerName === CUSTOM_BYOK_PROVIDER_NAME
    ? "synthetic"
    : normalizeProviderSlug(providerName);
}

type ByokProviderStatusKey =
  | "addModelId"
  | "customEndpoint"
  | "addCredential"
  | "byokModels"
  | "notConfigured";

function getByokProviderStatus(input: {
  customCount?: number;
  configured: boolean;
  providerName: string;
  type: ModelType;
}): ByokProviderStatusKey {
  void input.type;

  if (input.providerName === CUSTOM_BYOK_PROVIDER_NAME) {
    return input.configured ? "addModelId" : "customEndpoint";
  }

  if (!input.configured) {
    return "addCredential";
  }
  return (input.customCount ?? 0) > 0 ? "byokModels" : "addModelId";
}

function createCustomModelItemFromSelection(
  input: {
    selection: ByokModelSelection;
    type: ModelType;
  },
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
) {
  if (input.selection.mode !== "byok" || input.selection.source !== "custom") {
    return null;
  }

  const customModelName = input.selection.customModelName?.trim();
  const providerName = input.selection.providerName?.trim();
  if (!customModelName || !providerName) {
    return null;
  }

  const providerLabel = getByokProviderLabel(providerName, t);
  return createCustomModelItem(
    {
      byokCredentialAlias: input.selection.credentialAlias,
      byokCredentialId: input.selection.credentialId,
      byokModelId: input.selection.byokModelId,
      capabilities: input.selection.capabilities ?? null,
      modelAlias: customModelName,
      name: customModelName,
      providerLabel,
      providerSlug: normalizeProviderSlug(providerName),
      subtitle: t("modelSelector.byok.customModelSubtitle", {
        provider: providerLabel,
        type: modelTypeLabel(t, input.type),
      }),
    },
    t,
  );
}

function createCustomModelItemsFromSavedModels(
  input: {
    credentials: ByokCredentialItem[];
    savedModels: ByokSavedModelItem[];
    providerName: string;
    type: ModelType;
  },
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
) {
  const providerLabel = getByokProviderLabel(input.providerName, t);
  const providerSlug = normalizeProviderSlug(input.providerName);
  const seen = new Set<string>();
  const models: ModelItem[] = [];

  const credentialById = new Map(
    input.credentials.map((credential) => [credential.id, credential]),
  );
  for (const savedModel of input.savedModels) {
    if (
      savedModel.providerName !== input.providerName ||
      savedModel.modelType !== input.type
    ) {
      continue;
    }
    const credential = credentialById.get(savedModel.credentialId);
    const dedupeKey = `${savedModel.id}:${savedModel.modelName}:${savedModel.modelType}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    models.push({
      ...createCustomModelItem(
        {
          byokCredentialAlias: credential?.credentialAlias ?? null,
          capabilities:
            savedModel.capabilities as ModelThinkingCapabilities | null,
          modelAlias: savedModel.modelName,
          name: savedModel.displayName,
          providerLabel,
          providerSlug,
          subtitle: t("modelSelector.byok.savedModelSubtitle", {
            model: savedModel.modelName,
            credential: credential?.credentialAlias ?? providerLabel,
          }),
        },
        t,
      ),
      byokModelId: savedModel.id,
      byokCredentialId: savedModel.credentialId,
    });
  }

  return models;
}

function resolveByokSelectedModelItem(
  input: {
    availableModels: Record<ModelType, ModelItem[]>;
    selection: ByokModelSelection | null | undefined;
    type: ModelType;
  },
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
) {
  const selection = input.selection;
  if (!selection || selection.mode !== "byok") {
    return null;
  }

  if (selection.source === "catalog") {
    const catalogModel = findModelItemByAlias({
      alias: selection.modelAlias,
      availableModels: input.availableModels,
      type: input.type,
    });
    if (catalogModel) {
      return catalogModel;
    }

    const providerName = selection.providerName?.trim();
    const modelAlias = selection.modelAlias?.trim();
    if (!providerName || !modelAlias) {
      return null;
    }
    const providerLabel = getByokProviderLabel(providerName, t);
    return createCustomModelItem(
      {
        byokCredentialAlias: selection.credentialAlias,
        byokCredentialId: selection.credentialId,
        byokModelId: selection.byokModelId,
        capabilities: selection.capabilities ?? null,
        modelAlias,
        name: modelAlias,
        providerLabel,
        providerSlug: normalizeProviderSlug(providerName),
        subtitle: t("modelSelector.byok.selectedModelSubtitle", {
          provider: providerLabel,
          type: modelTypeLabel(t, input.type),
        }),
      },
      t,
    );
  }

  return createCustomModelItemFromSelection(
    {
      selection,
      type: input.type,
    },
    t,
  );
}

export function resolveSelectedModelsWithByok(
  input: {
    availableModels: Record<ModelType, ModelItem[]>;
    baseSelectedModels: SelectedModels;
    byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
  },
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas">>,
) {
  const nextModels: SelectedModels = { ...input.baseSelectedModels };

  for (const type of ["llm", "image", "vision"] as const) {
    const model = resolveByokSelectedModelItem(
      {
        availableModels: input.availableModels,
        selection: input.byokSelections?.[type],
        type,
      },
      t,
    );
    if (model) {
      nextModels[type] = model;
    }
  }

  return nextModels;
}

function getSelectableByokProviders(providers: ByokProviderOption[]) {
  const seen = new Set<string>();
  const options: ByokProviderOption[] = [];
  const existingCustom = providers.find(
    (provider) => provider.providerName === CUSTOM_BYOK_PROVIDER_NAME,
  );

  for (const provider of providers) {
    const providerName = provider.providerName.trim();
    if (
      !provider.system ||
      !providerName ||
      providerName === CUSTOM_BYOK_PROVIDER_NAME ||
      seen.has(providerName)
    ) {
      continue;
    }

    options.push(provider);
    seen.add(providerName);
  }

  options.push({
    baseUrl: existingCustom?.baseUrl ?? null,
    hasApiKey: existingCustom?.hasApiKey ?? false,
    isByokOnly: true,
    providerKind: DEFAULT_BYOK_PROVIDER_KIND,
    providerName: CUSTOM_BYOK_PROVIDER_NAME,
    system: false,
  });

  return options;
}

function resolveSelectableByokProviderName(
  providerName: string | null | undefined,
  providerOptions: ByokProviderOption[],
) {
  const requestedProviderName = providerName?.trim();
  if (!requestedProviderName) {
    return "";
  }
  if (
    providerOptions.some(
      (provider) => provider.providerName === requestedProviderName,
    )
  ) {
    return requestedProviderName;
  }
  return CUSTOM_BYOK_PROVIDER_NAME;
}

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
  disableCommandFilter = false,
  models,
  onSelect,
  scrollToSelectedKey,
  selectedModel,
  showEmpty = true,
}: {
  disableCommandFilter?: boolean;
  models: ModelItem[];
  onSelect: (model: ModelItem) => void;
  scrollToSelectedKey?: string | number | null;
  selectedModel: ModelItem | null;
  showEmpty?: boolean;
}) {
  const t = useTranslations("dashboardChatCanvas");
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
    <ModelSelectorList className="max-h-full flex-1 overflow-y-auto">
      {showEmpty ? (
        <ModelSelectorEmpty>
          {t("modelSelector.noModelsAvailable")}
        </ModelSelectorEmpty>
      ) : null}
      {chefs.map((chef) => (
        <ModelSelectorGroup
          forceMount={disableCommandFilter ? true : undefined}
          heading={chef}
          key={chef}
        >
          {models
            .concat()
            .filter((model) => model.chef === chef)
            .map((model) => {
              const selected = selectedModel?.id === model.id;

              return (
                <ModelSelectorItem
                  data-checked={selected ? true : undefined}
                  forceMount={disableCommandFilter ? true : undefined}
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
  byokCredentials,
  byokModels,
  byokProviders,
  byokSelection,
  byokSelectedModel,
  onAddModel,
  onSelect,
  scrollToSelectedKey,
  selectedModel,
  type,
}: {
  byokCredentials: ByokCredentialItem[];
  byokModels: ByokSavedModelItem[];
  byokProviders: ByokProviderOption[];
  byokSelection: ByokModelSelection | null;
  byokSelectedModel: ModelItem | null;
  onAddModel?: (input: {
    credentialId?: string;
    providerKind?: string;
    providerName?: string;
  }) => void;
  onSelect: (input: {
    model: ModelItem;
    selection: ByokModelSelection;
  }) => void;
  scrollToSelectedKey?: string | number | null;
  selectedModel: ModelItem | null;
  type: ModelType;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const byokProviderLabel = (name: string) =>
    name === CUSTOM_BYOK_PROVIDER_NAME
      ? t("modelSelector.byok.customProvider")
      : toProviderLabel(name);
  const statusLabel = (key: ByokProviderStatusKey) =>
    t(`modelSelector.byok.status.${key}`);
  const typeLabel = t(`modelSelector.type.${type}`);
  const addModelLabel = t(`modelSelector.byok.addModel.${type}`);
  const addCredentialLabel = t(`modelSelector.byok.addCredential.${type}`);
  const [providerName, setProviderName] = useState<string>("");
  const [query, setQuery] = useState("");
  const providerOptions = useMemo(
    () => getSelectableByokProviders(byokProviders),
    [byokProviders],
  );

  useEffect(() => {
    const nextProvider = resolveSelectableByokProviderName(
      byokSelection?.providerName,
      providerOptions,
    );
    const currentProviderStillAvailable = providerOptions.some(
      (provider) => provider.providerName === providerName,
    );

    if (!providerName && nextProvider) {
      setProviderName(nextProvider);
      return;
    }
    if (!providerName && providerOptions[0]) {
      setProviderName(providerOptions[0].providerName);
      return;
    }
    if (providerName && !currentProviderStillAvailable) {
      setProviderName(nextProvider || providerOptions[0]?.providerName || "");
    }
  }, [byokSelection?.providerName, providerName, providerOptions]);

  const provider =
    providerOptions.find((item) => item.providerName === providerName) ?? null;
  const providerLabel = provider
    ? byokProviderLabel(provider.providerName)
    : t("modelSelector.byokTab");
  const providerCredentials = byokCredentials.filter(
    (item) => item.providerName === providerName,
  );
  const customModels = createCustomModelItemsFromSavedModels(
    {
      credentials: byokCredentials,
      providerName,
      savedModels: byokModels,
      type,
    },
    t,
  );
  const selectionCustomModel =
    byokSelection?.mode === "byok" &&
    byokSelection.providerName === providerName
      ? createCustomModelItemFromSelection({ selection: byokSelection, type }, t)
      : null;
  const knownModelMap = new Map<string, ModelItem>();
  for (const model of customModels) {
    knownModelMap.set(model.id, model);
  }
  if (selectionCustomModel) {
    knownModelMap.set(selectionCustomModel.id, selectionCustomModel);
  }
  if (
    byokSelection?.mode === "byok" &&
    byokSelection.providerName === providerName &&
    byokSelectedModel
  ) {
    knownModelMap.set(byokSelectedModel.id, byokSelectedModel);
  }
  const knownModels = Array.from(knownModelMap.values());
  const hasKnownModels = knownModels.length > 0;
  const filteredKnownModels = knownModels.filter((model) => {
    const haystack =
      `${model.name} ${model.subtitle} ${model.modelAlias}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const selectedProviderHasKey = providerCredentials.length > 0;
  const providerStatus = provider
    ? statusLabel(
        getByokProviderStatus({
          customCount: customModels.length,
          configured: selectedProviderHasKey,
          providerName: provider.providerName,
          type,
        }),
      )
    : statusLabel("notConfigured");
  const handleAddModel = () => {
    onAddModel?.({
      credentialId: providerCredentials[0]?.id,
      providerKind: provider?.providerKind,
      providerName: providerName || undefined,
    });
  };

  return (
    <div className="px-2 pt-2 pb-1">
      <div className="flex h-[min(382px,calc(100svh-14rem))] min-h-0 overflow-hidden rounded-lg border border-border/70 bg-background">
        <aside className="flex w-12 shrink-0 flex-col border-r border-border/70 bg-muted/10">
          <TooltipProvider>
            <ModelSelectorList className="max-h-none min-h-0 flex-1 overflow-y-auto py-1.5">
              <ModelSelectorGroup className="p-1" forceMount>
                {providerOptions.map((item) => {
                  const selected = item.providerName === providerName;
                  const providerItemLabel = byokProviderLabel(
                    item.providerName,
                  );
                  const credentialCount = byokCredentials.filter(
                    (credential) =>
                      credential.providerName === item.providerName,
                  ).length;
                  const status = statusLabel(
                    getByokProviderStatus({
                      customCount: createCustomModelItemsFromSavedModels(
                        {
                          credentials: byokCredentials,
                          providerName: item.providerName,
                          savedModels: byokModels,
                          type,
                        },
                        t,
                      ).length,
                      configured: credentialCount > 0,
                      providerName: item.providerName,
                      type,
                    }),
                  );

                  return (
                    <Tooltip key={item.providerName}>
                      <TooltipTrigger asChild>
                        <ModelSelectorItem
                          aria-label={`${providerItemLabel}: ${status}`}
                          className="mx-auto flex size-8 justify-center rounded-lg p-0 data-[checked=true]:bg-background data-[checked=true]:shadow-xs data-[checked=true]:ring-1 data-[checked=true]:ring-border [&>svg:last-child]:hidden"
                          data-checked={selected ? true : undefined}
                          forceMount
                          onSelect={() => setProviderName(item.providerName)}
                          value={`provider ${providerItemLabel} ${item.providerName}`}
                        >
                          <ModelSelectorLogo
                            className="size-4"
                            provider={getByokProviderLogoSlug(
                              item.providerName,
                            )}
                          />
                        </ModelSelectorItem>
                      </TooltipTrigger>
                      <TooltipContent
                        align="center"
                        side="right"
                        sideOffset={8}
                      >
                        <div className="text-xs font-medium">
                          {providerItemLabel}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {status}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </ModelSelectorGroup>
            </ModelSelectorList>
          </TooltipProvider>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-background">
          <div className="flex h-10 items-center gap-2 border-b border-border/70 px-3">
            <ModelSelectorLogo
              className="size-4"
              provider={
                provider
                  ? getByokProviderLogoSlug(provider.providerName)
                  : "synthetic"
              }
            />
            <ModelSelectorName className="text-sm font-semibold text-foreground">
              {providerLabel}
            </ModelSelectorName>
            <Badge
              className="h-4 rounded-md px-1.5 text-[9px]"
              variant="outline"
            >
              {provider?.system
                ? t("modelSelector.byok.system")
                : t("modelSelector.byok.custom")}
            </Badge>
            <div className="ml-auto shrink-0 text-xs text-muted-foreground">
              {providerStatus}
            </div>
          </div>

          {!selectedProviderHasKey ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="max-w-[260px] px-4 py-6 text-center">
                <KeyRound className="mx-auto mb-2 size-5 text-muted-foreground" />
                <div className="text-sm font-medium text-foreground">
                  {t("modelSelector.byok.noModelsConfigured", {
                    provider: providerLabel,
                  })}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {providerName === CUSTOM_BYOK_PROVIDER_NAME
                    ? t("modelSelector.byok.getStartedAddModel")
                    : t("modelSelector.byok.getStartedSaveKey")}
                </div>
                <Button
                  className="mt-4"
                  onClick={handleAddModel}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {providerName === CUSTOM_BYOK_PROVIDER_NAME
                    ? addModelLabel
                    : addCredentialLabel}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col space-y-3 p-3">
                <Input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("modelSelector.searchModels")}
                  value={query}
                />
                {filteredKnownModels.length > 0 ? (
                  <CatalogModelList
                    disableCommandFilter
                    models={filteredKnownModels}
                    onSelect={(model) => {
                      if (!providerName || !model.byokModelId) {
                        return;
                      }
                      const selection = toByokSelectionFromCustomModel({
                        byokModelId: model.byokModelId,
                        capabilities: model.capabilities ?? null,
                        credentialId: model.byokCredentialId ?? null,
                        credentialAlias: model.byokCredentialAlias ?? null,
                        modelName: model.modelAlias,
                        providerName,
                      });
                      onSelect({ model, selection });
                    }}
                    scrollToSelectedKey={scrollToSelectedKey}
                    selectedModel={
                      byokSelection?.mode === "byok" ? selectedModel : null
                    }
                    showEmpty={false}
                  />
                ) : (
                  <div className="rounded-md border border-dashed border-border/70 bg-muted/15 px-3 py-4 text-xs text-muted-foreground">
                    {hasKnownModels
                      ? t("modelSelector.byok.noModelsMatchSearch")
                      : t("modelSelector.byok.noSavedModels", {
                          type: typeLabel.toLowerCase(),
                          provider: providerLabel,
                        })}
                  </div>
                )}
              </div>
              <div className="mt-auto border-t border-border/70 p-2">
                <Button
                  className="h-9 w-full justify-start gap-2 rounded-lg"
                  onClick={handleAddModel}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Plus className="size-4 text-primary" />
                  <span className="text-sm font-medium">{addModelLabel}</span>
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SelectorPanel({
  activeTab,
  availableModels,
  byokCredentials,
  byokModels,
  byokProviders,
  byokSelections,
  onAddByokModel,
  onByokSelect,
  onModelSelect,
  selectedModels,
  setActiveTab,
  setOpen,
  setSelectedModels,
  scrollToSelectedKey,
}: {
  activeTab: ModelType;
  availableModels: Record<ModelType, ModelItem[]>;
  byokCredentials?: ByokCredentialItem[];
  byokModels?: ByokSavedModelItem[];
  byokProviders?: ByokProviderOption[];
  byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
  onAddByokModel?: (input: {
    credentialId?: string;
    providerKind?: string;
    providerName?: string;
    type: ModelType;
  }) => void;
  onByokSelect?: (input: {
    model: ModelItem;
    selection: ByokModelSelection;
    type: ModelType;
  }) => void;
  onModelSelect?: (input: { type: ModelType; model: ModelItem }) => void;
  selectedModels: SelectedModels;
  setActiveTab: Dispatch<SetStateAction<ModelType>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
  scrollToSelectedKey?: number;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const [modelModes, setModelModes] = useState<
    Record<ModelType, "global" | "byok">
  >({
    image: byokSelections?.image?.mode === "byok" ? "byok" : "global",
    llm: byokSelections?.llm?.mode === "byok" ? "byok" : "global",
    vision: byokSelections?.vision?.mode === "byok" ? "byok" : "global",
  });

  useEffect(() => {
    setModelModes((current) => ({
      image: byokSelections?.image?.mode === "byok" ? "byok" : current.image,
      llm: byokSelections?.llm?.mode === "byok" ? "byok" : current.llm,
      vision: byokSelections?.vision?.mode === "byok" ? "byok" : current.vision,
    }));
  }, [
    byokSelections?.image?.mode,
    byokSelections?.llm?.mode,
    byokSelections?.vision?.mode,
  ]);

  return (
    <Tabs
      className="w-full gap-0"
      onValueChange={(value) => setActiveTab(value as ModelType)}
      value={activeTab}
    >
      <div className="border-b border-border/70 pb-1.5">
        <TabsList
          className="grid h-10 w-full grid-cols-3 rounded-none bg-transparent px-1 pt-1"
          variant="line"
        >
          {(["llm", "image", "vision"] as ModelType[]).map((type) => (
            <TabsTrigger
              className="h-full rounded-t-md border-b border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground data-active:border-foreground data-active:bg-transparent data-active:text-foreground data-active:shadow-none"
              key={type}
              value={type}
            >
              <ModelTypeIcon type={type} />
              {t(`modelSelector.type.${type}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {(["llm", "image", "vision"] as ModelType[]).map((type) => (
        <TabsContent className="mt-0" key={type} value={type}>
          <div className="px-2 pt-3 pb-1.5">
            <Tabs
              className="w-full gap-0"
              onValueChange={(value) =>
                setModelModes((current) => ({
                  ...current,
                  [type]: value as "global" | "byok",
                }))
              }
              value={modelModes[type]}
            >
              <TabsList className="grid h-9 w-full grid-cols-2 rounded-lg bg-muted/60 p-1">
                <TabsTrigger
                  className="rounded-md text-xs data-active:bg-background data-active:shadow-xs"
                  value="global"
                >
                  {t("modelSelector.global")}
                </TabsTrigger>
                <TabsTrigger
                  className="rounded-md text-xs data-active:bg-background data-active:shadow-xs"
                  value="byok"
                >
                  {t("modelSelector.byokTab")}
                </TabsTrigger>
              </TabsList>
              <TabsContent className="mt-0" value="global">
                <div className="flex h-[min(382px,calc(100svh-14rem))] min-h-0 flex-col px-2 pt-2 pb-1">
                  <div className="shrink-0 pb-2">
                    <ModelSelectorInput
                      placeholder={t("modelSelector.searchModelsEllipsis")}
                    />
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
                      modelModes[type] === "global"
                        ? `${scrollToSelectedKey}:${type}:global`
                        : null
                    }
                    selectedModel={selectedModels[type]}
                  />
                </div>
              </TabsContent>
              <TabsContent className="mt-0" value="byok">
                <ByokPanel
                  byokCredentials={byokCredentials ?? []}
                  byokModels={byokModels ?? []}
                  byokProviders={byokProviders ?? []}
                  byokSelection={byokSelections?.[type] ?? null}
                  byokSelectedModel={
                    byokSelections?.[type]?.mode === "byok"
                      ? selectedModels[type]
                      : null
                  }
                  onAddModel={(input) => {
                    setOpen(false);
                    onAddByokModel?.({ ...input, type });
                  }}
                  onSelect={({ model, selection }) => {
                    setSelectedModels((current) => ({
                      ...current,
                      [type]: model,
                    }));
                    onByokSelect?.({ model, selection, type });
                    setOpen(false);
                  }}
                  scrollToSelectedKey={
                    byokSelections?.[type]?.source === "catalog" &&
                    modelModes[type] === "byok"
                      ? `${scrollToSelectedKey}:${type}:byok`
                      : null
                  }
                  selectedModel={selectedModels[type]}
                  type={type}
                />
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function HeaderModelSelector({
  availableModels = emptyModelCatalog,
  byokCredentials = [],
  byokModels = [],
  byokProviders = [],
  byokSelections = {},
  isLoading = false,
  compact = false,
  iconOnly = false,
  onAddByokModel,
  onByokSelect,
  onModelSelect,
  selectedModels,
  setSelectedModels,
}: {
  availableModels?: Record<ModelType, ModelItem[]>;
  byokCredentials?: ByokCredentialItem[];
  byokModels?: ByokSavedModelItem[];
  byokProviders?: ByokProviderOption[];
  byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
  isLoading?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  onAddByokModel?: (input: {
    credentialId?: string;
    providerKind?: string;
    providerName?: string;
    type: ModelType;
  }) => void;
  onByokSelect?: (input: {
    model: ModelItem;
    selection: ByokModelSelection;
    type: ModelType;
  }) => void;
  onModelSelect?: (input: { type: ModelType; model: ModelItem }) => void;
  selectedModels: SelectedModels;
  setSelectedModels: Dispatch<SetStateAction<SelectedModels>>;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ModelType>("llm");
  const [openSequence, setOpenSequence] = useState(0);
  const isCompactModelSelector = compact;
  const primaryModel =
    byokSelections.llm?.mode === "byok"
      ? resolveByokSelectedModelItem(
          {
            availableModels,
            selection: byokSelections.llm,
            type: "llm",
          },
          t,
        )
      : selectedModels.llm;
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setOpenSequence((current) => current + 1);
    }
  };
  return (
    <ModelSelector onOpenChange={handleOpenChange} open={open}>
      <TooltipProvider>
        {isCompactModelSelector ? (
          <ModelSelectorTrigger asChild>
            <button
              type="button"
              aria-label={t("modelSelector.modelsAriaLabel", {
                model: primaryModel?.name ?? t("modelSelector.auto"),
              })}
              title={t("modelSelector.selectModelsTitle")}
              aria-busy={isLoading && !primaryModel}
              disabled={isLoading && !primaryModel}
              onClick={() => setActiveTab("llm")}
              className={cn(
                "flex h-8 min-w-0 shrink-0 items-center rounded-md border border-border/60 bg-background px-2 text-xs text-foreground shadow-xs",
                iconOnly ? "max-w-28 gap-1" : "max-w-40 gap-1.5",
              )}
            >
              {/* Phone widths name the model instead of showing the type glyph: the
                  trigger is the only model affordance on screen there, and a lone icon
                  reads as decoration. Wider layouts keep the icon. */}
              {!iconOnly && <ModelTypeIcon type="llm" />}
              <span className="min-w-0 truncate">
                {isLoading && !primaryModel
                  ? t("modelSelector.loadingModels")
                  : (primaryModel?.name ?? t("modelSelector.auto"))}
              </span>
              {byokSelections.llm?.mode === "byok" ? (
                <KeyRound className="size-3 shrink-0" />
              ) : null}
              <ChevronDown className="size-3 shrink-0" />
            </button>
          </ModelSelectorTrigger>
        ) : (
          <div className="flex h-10 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-background px-1 py-0.5 shadow-xs">
            {(["llm", "image", "vision"] as ModelType[]).map((type) => {
              const byokSelection = byokSelections[type] ?? null;
              const byokModel =
                byokSelection?.mode === "byok"
                  ? resolveByokSelectedModelItem(
                      {
                        availableModels,
                        selection: byokSelection,
                        type,
                      },
                      t,
                    )
                  : null;
              const model =
                byokModel ??
                selectedModels[type] ??
                availableModels[type]?.[0] ??
                null;
              const isCatalogLoading = isLoading && !model;
              const showByokBadge = byokSelection?.mode === "byok";
              const typeLabel = t(`modelSelector.type.${type}`);

              return (
                <Tooltip key={type}>
                  <TooltipTrigger asChild>
                    <ModelSelectorTrigger asChild>
                      <button
                        aria-busy={isCatalogLoading || undefined}
                        aria-label={
                          isCatalogLoading
                            ? t("modelSelector.typeModelsLoading", {
                                type: typeLabel,
                              })
                            : t("modelSelector.typeModelAria", {
                                type: typeLabel,
                                model: model?.name ?? t("modelSelector.none"),
                              })
                        }
                        className="flex min-w-0 max-w-[152px] items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 aria-expanded:bg-muted/50"
                        disabled={isCatalogLoading}
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
                            {isCatalogLoading ? (
                              <span className="block h-2.5 w-16 animate-pulse rounded-full bg-muted-foreground/25" />
                            ) : (
                              (model?.name ??
                              t("modelSelector.noTypeModel", {
                                type: typeLabel,
                              }))
                            )}
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
                    {isCatalogLoading
                      ? t("modelSelector.typeModelsLoading", {
                          type: typeLabel,
                        })
                      : byokSelection?.mode === "byok"
                        ? t("modelSelector.byokTooltip", {
                            type: typeLabel,
                            model: model?.name ?? "BYOK",
                            provider: byokSelection.providerName ?? "BYOK",
                          })
                        : model
                          ? t("modelSelector.typeTooltip", {
                              type: typeLabel,
                              model: model.name,
                            })
                          : t("modelSelector.noTypeModelAvailable", {
                              type: typeLabel,
                            })}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}
      </TooltipProvider>

      <ModelSelectorContent
        className="max-h-[calc(100svh-2rem)] max-w-[92vw] overflow-y-auto sm:max-w-[520px]"
        title={t("modelSelector.selectModelTitle")}
      >
        <SelectorPanel
          activeTab={activeTab}
          availableModels={availableModels}
          byokCredentials={byokCredentials}
          byokModels={byokModels}
          byokProviders={byokProviders}
          byokSelections={byokSelections}
          onAddByokModel={onAddByokModel}
          onByokSelect={onByokSelect}
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
