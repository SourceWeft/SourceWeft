import type {
  ByokCredentialItem,
  ByokModelSelection,
  ByokSavedModelItem,
} from "./byok-state";

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

/**
 * Everything the models the user has selected advertise about themselves, as
 * one opaque record.
 *
 * Capabilities annotate model-catalog rows under a key they choose, and a row
 * only carries annotations for its own model kind, so the keys of the three
 * selections do not collide. Merging rather than routing by kind is deliberate:
 * a client resolving an option's `modelValues` pointer names a key, not a kind,
 * so a capability that annotates a different model kind than the ones we happen
 * to have in mind today needs no edit here.
 *
 * Values stay `unknown`. Nothing on this side of the boundary reads them; they
 * are only walked by path on behalf of the capability that wrote them.
 */
export function selectedModelCapabilities(
  selectedModels: SelectedModels,
): Record<string, unknown> {
  return {
    ...(selectedModels.llm?.capabilities ?? {}),
    ...(selectedModels.vision?.capabilities ?? {}),
    ...(selectedModels.image?.capabilities ?? {}),
  };
}

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

export function isDefaultCatalogModel(model: ModelItem | null | undefined) {
  const profileAlias = model?.profileAlias?.trim();
  return Boolean(profileAlias && GLOBAL_AUTO_MODEL_ALIASES.has(profileAlias));
}

function isInternalOpenRouterAlias(alias: string) {
  return alias.startsWith("global-openrouter-");
}

function deriveDisplayNameFromAlias(alias: string) {
  const modelPart = alias.replace(/^global-openrouter-(chat|image|vision):/, "");
  if (!modelPart || modelPart === alias) {
    return alias;
  }
  return modelPart.split("/").at(-1) ?? modelPart;
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
    : displayName === entry.modelAlias &&
        isInternalOpenRouterAlias(entry.modelAlias)
      ? subtitle !== entry.modelAlias
        ? subtitle
        : deriveDisplayNameFromAlias(entry.modelAlias)
      : displayName;

  return {
    chef: providerLabel,
    chefSlug: providerSlug,
    id: entry.profileAlias,
    profileAlias: entry.profileAlias,
    modelAlias: entry.modelAlias,
    name,
    logoSrc: isGlobalAutoModel ? SOURCEWEFT_LOGO_SRC : undefined,
    provider: providerSlug,
    subtitle: isGlobalAutoModel ? "Global models" : subtitle,
    badges: Array.from(
      new Set([
        ...(entry.badges ?? []),
        ...(entry.capabilities?.supportsThinking ? ["Thinking"] : []),
        ...(entry.capabilities?.imageGeneration?.supported ? ["Image"] : []),
      ]),
    ),
    capabilities: entry.capabilities,
    availableViaGlobal: entry.availableViaGlobal ?? false,
    availableViaByokProviders: entry.availableViaByokProviders ?? [],
    selectionOrigin: "catalog",
  };
}

export function createCustomModelItem(input: {
  byokCredentialId?: string | null;
  byokModelId?: string | null;
  capabilities?: ModelThinkingCapabilities | null;
  modelAlias: string;
  name?: string;
  byokCredentialAlias?: string | null;
  providerLabel: string;
  providerSlug: string;
  subtitle?: string;
}) {
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
    subtitle: input.subtitle?.trim() || `${input.providerLabel} BYOK`,
    byokCredentialId: input.byokCredentialId ?? null,
    byokCredentialAlias,
    byokModelId: input.byokModelId ?? null,
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
  if (!aliases) return [];
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
      if (match) return match;
    }
    return null;
  };

  return (
    resolveByAliases(resolveAliasesForType(input.type, input.threadAliases)) ??
    resolveByAliases(resolveAliasesForType(input.type, input.fallbackAliases)) ??
    kindModels[0] ??
    null
  );
}

export function resolveSelectedModels(input: {
  availableModels: Record<ModelType, ModelItem[]>;
  threadAliases?: ModelAliasSettings;
  fallbackAliases?: ModelAliasSettings;
}): SelectedModels {
  return {
    llm: pickSelectedModelForType({ ...input, type: "llm" }),
    image: pickSelectedModelForType({ ...input, type: "image" }),
    vision: pickSelectedModelForType({ ...input, type: "vision" }),
  };
}

export function findModelItemByAlias(input: {
  availableModels: Record<ModelType, ModelItem[]>;
  type: ModelType;
  alias?: string | null;
}) {
  const alias = input.alias?.trim();
  if (!alias) return null;
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

const CUSTOM_BYOK_PROVIDER_NAME = "custom";

function getByokProviderLabel(providerName: string) {
  return providerName === CUSTOM_BYOK_PROVIDER_NAME
    ? "Custom Provider"
    : toProviderLabel(providerName);
}

function createCustomModelItemFromSelection(input: {
  selection: ByokModelSelection;
  type: ModelType;
}) {
  if (input.selection.mode !== "byok" || input.selection.source !== "custom") {
    return null;
  }
  const customModelName = input.selection.customModelName?.trim();
  const providerName = input.selection.providerName?.trim();
  if (!customModelName || !providerName) return null;

  const providerLabel = getByokProviderLabel(providerName);
  return createCustomModelItem({
    byokCredentialAlias: input.selection.credentialAlias,
    byokCredentialId: input.selection.credentialId,
    byokModelId: input.selection.byokModelId,
    capabilities: input.selection.capabilities ?? null,
    modelAlias: customModelName,
    name: customModelName,
    providerLabel,
    providerSlug: normalizeProviderSlug(providerName),
    subtitle: `${providerLabel} custom ${modelTypeLabels[input.type]} BYOK`,
  });
}

export function createCustomModelItemsFromSavedModels(input: {
  credentials: ByokCredentialItem[];
  savedModels: ByokSavedModelItem[];
  providerName: string;
  type: ModelType;
}) {
  const providerLabel = getByokProviderLabel(input.providerName);
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
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    models.push({
      ...createCustomModelItem({
        byokCredentialAlias: credential?.credentialAlias ?? null,
        capabilities: savedModel.capabilities as ModelThinkingCapabilities | null,
        modelAlias: savedModel.modelName,
        name: savedModel.displayName,
        providerLabel,
        providerSlug,
        subtitle: `${savedModel.modelName} via ${credential?.credentialAlias ?? providerLabel}`,
      }),
      byokModelId: savedModel.id,
      byokCredentialId: savedModel.credentialId,
    });
  }
  return models;
}

function resolveByokSelectedModelItem(input: {
  availableModels: Record<ModelType, ModelItem[]>;
  selection: ByokModelSelection | null | undefined;
  type: ModelType;
}) {
  const selection = input.selection;
  if (!selection || selection.mode !== "byok") return null;

  if (selection.source === "catalog") {
    const catalogModel = findModelItemByAlias({
      alias: selection.modelAlias,
      availableModels: input.availableModels,
      type: input.type,
    });
    if (catalogModel) return catalogModel;

    const providerName = selection.providerName?.trim();
    const modelAlias = selection.modelAlias?.trim();
    if (!providerName || !modelAlias) return null;
    const providerLabel = getByokProviderLabel(providerName);
    return createCustomModelItem({
      byokCredentialAlias: selection.credentialAlias,
      byokCredentialId: selection.credentialId,
      byokModelId: selection.byokModelId,
      capabilities: selection.capabilities ?? null,
      modelAlias,
      name: modelAlias,
      providerLabel,
      providerSlug: normalizeProviderSlug(providerName),
      subtitle: `${providerLabel} ${modelTypeLabels[input.type]} BYOK`,
    });
  }

  return createCustomModelItemFromSelection({ selection, type: input.type });
}

export function resolveSelectedModelsWithByok(input: {
  availableModels: Record<ModelType, ModelItem[]>;
  baseSelectedModels: SelectedModels;
  byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
}) {
  const nextModels: SelectedModels = { ...input.baseSelectedModels };
  for (const type of ["llm", "image", "vision"] as const) {
    const model = resolveByokSelectedModelItem({
      availableModels: input.availableModels,
      selection: input.byokSelections?.[type],
      type,
    });
    if (model) nextModels[type] = model;
  }
  return nextModels;
}
