/**
 * Source-neutral model metadata. Every data source (models.dev, LiteLLM,
 * hand-authored overrides) is adapted into this shape, so downstream code never
 * depends on any one source's field names — swap or add a source by writing a
 * single adapter to `NormalizedModelInfo[]`.
 */

export type ModelModality =
  | "chat"
  | "vision"
  | "image"
  | "embedding"
  | "tts"
  | "video";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Image price tier keyed by request quality + size, mirroring LiteLLM's
 * `{quality}/{WxH}/{model}` price-book entries. `quality`/`size` omitted = a
 * wildcard fallback tier. per-image (input_cost_per_image) and per-pixel
 * (input_cost_per_pixel) are the two per-request image dimensions LiteLLM uses.
 */
export interface ImagePricingTier {
  quality?: string;
  size?: string;
  perImage?: number | null;
  perPixel?: number | null;
}

/** Per-token USD prices (image/second priced per unit). Null = unknown. */
export interface ModelPricingInfo {
  inputPerToken?: number | null;
  outputPerToken?: number | null;
  cacheReadPerToken?: number | null;
  cacheWritePerToken?: number | null;
  reasoningOutputPerToken?: number | null;
  audioInputPerToken?: number | null;
  audioOutputPerToken?: number | null;
  // gpt-image family: image billed as tokens (LiteLLM input/output_cost_per_image_token).
  inputImageTokenPerToken?: number | null;
  outputImageTokenPerToken?: number | null;
  // Flat per-image price (LiteLLM input/output_cost_per_image), the untiered default.
  inputPerImage?: number | null;
  outputPerImage?: number | null;
  // dall-e / imagen / flux: per-image or per-pixel, tiered by quality + size.
  imageTiers?: ImagePricingTier[];
}

export interface NormalizedModelInfo {
  /** Canonical model id (provider/model or bare), lowercased. */
  id: string;
  /**
   * Canonical serving-provider key this entry's data (esp. price) belongs to —
   * the models.dev top-level provider or LiteLLM `litellm_provider`, normalized.
   * Undefined for provider-agnostic entries. Two providers price the same model
   * id differently, so pricing is only trustworthy within one provider's bucket.
   */
  provider?: string;
  modality?: ModelModality;
  reasoning: boolean;
  reasoningEfforts: ReasoningEffort[];
  toolCall: boolean;
  structuredOutput: boolean;
  vision: boolean;
  contextTokens?: number | null;
  maxOutputTokens?: number | null;
  pricing?: ModelPricingInfo;
  /** Provenance, e.g. ["litellm","models.dev","override"]. */
  sources: string[];
}

/** A hand-authored override: any subset of the neutral fields, applied on top. */
export type ModelInfoOverride = Partial<
  Omit<NormalizedModelInfo, "id" | "sources">
>;

export const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function bareModelName(id: string): string {
  return id.split("/").at(-1)?.trim().toLowerCase() ?? "";
}

export function canonicalModelId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Aliases mapping the provider keys our gateway config / LiteLLM use onto the
 * models.dev top-level provider keys, so a provider bucket unions all sources.
 * Only entries whose spellings actually diverge need listing.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  together: "togetherai",
  together_ai: "togetherai",
  "together-ai": "togetherai",
  siliconflowcn: "siliconflow-cn",
  "cloudflare-aig": "cloudflare-ai-gateway",
  vertex_ai: "google-vertex",
  "text-completion-openai": "openai",
};

/** Normalize a raw provider key (lowercase + alias). Undefined when empty. */
export function canonicalProviderKey(
  raw: string | null | undefined,
): string | undefined {
  const key = raw?.trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  return PROVIDER_ALIASES[key] ?? key;
}

/** The serving provider a `provider/model` id names, if it carries a prefix. */
export function providerFromId(id: string): string | undefined {
  const slash = id.indexOf("/");
  return slash > 0 ? canonicalProviderKey(id.slice(0, slash)) : undefined;
}

/**
 * Strip a trailing dated/numbered snapshot suffix so a versioned id can fall
 * back to its base model (e.g. `deepseek-v4-pro-0813` → `deepseek-v4-pro`).
 * Used only as a last-resort match — accepted solely when it hits a known model.
 */
export function stripSnapshotSuffix(name: string): string {
  return name
    .replace(/-free$/, "")
    .replace(/-20\d{2}-\d{2}-\d{2}$/, "")
    .replace(/-\d{3,4}$/, "");
}

const EMPTY_INFO_BASE = {
  reasoning: false,
  reasoningEfforts: [] as ReasoningEffort[],
  toolCall: false,
  structuredOutput: false,
  vision: false,
} satisfies Partial<NormalizedModelInfo>;

export function emptyModelInfo(id: string): NormalizedModelInfo {
  return { id: canonicalModelId(id), ...EMPTY_INFO_BASE, sources: [] };
}

function dedupeEfforts(efforts: ReasoningEffort[]): ReasoningEffort[] {
  const set = new Set(efforts);
  return EFFORT_ORDER.filter((effort) => set.has(effort));
}

function tierKey(tier: ImagePricingTier): string {
  return `${tier.quality ?? "*"} ${tier.size ?? "*"}`;
}

/**
 * Field-level pricing merge, `next` winning per scalar field — but only where
 * `next` actually carries a value. A `null`/`undefined` field in `next` means
 * "unknown", so it leaves `base` intact rather than wiping it: when models.dev
 * (primary) lists a model with a stale/partial price, LiteLLM's value fills the
 * gap, and once models.dev catches up its real value wins again. `imageTiers`
 * arrays are unioned (next's tier wins on the same quality+size key).
 */
function mergePricing(
  base: ModelPricingInfo | undefined,
  next: ModelPricingInfo | undefined,
): ModelPricingInfo | undefined {
  if (!base && !next) {
    return undefined;
  }
  const merged: ModelPricingInfo = { ...base };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (key === "imageTiers" || value === null || value === undefined) {
      continue;
    }
    (merged as Record<string, unknown>)[key] = value;
  }
  const baseTiers = base?.imageTiers ?? [];
  const nextTiers = next?.imageTiers ?? [];
  if (baseTiers.length > 0 || nextTiers.length > 0) {
    const byKey = new Map<string, ImagePricingTier>();
    for (const tier of [...baseTiers, ...nextTiers]) {
      byKey.set(tierKey(tier), tier);
    }
    merged.imageTiers = Array.from(byKey.values());
  }
  return merged;
}

/**
 * Field-level merge, `next` winning: booleans/arrays from `next` take over,
 * optional fields from `next` only when present. Sources accumulate.
 */
export function mergeModelInfo(
  base: NormalizedModelInfo | undefined,
  next: NormalizedModelInfo,
): NormalizedModelInfo {
  if (!base) {
    return next;
  }
  return {
    id: base.id,
    provider: next.provider ?? base.provider,
    modality: next.modality ?? base.modality,
    reasoning: next.reasoning || base.reasoning,
    reasoningEfforts: dedupeEfforts([
      ...base.reasoningEfforts,
      ...next.reasoningEfforts,
    ]),
    toolCall: next.toolCall || base.toolCall,
    structuredOutput: next.structuredOutput || base.structuredOutput,
    vision: next.vision || base.vision,
    contextTokens: next.contextTokens ?? base.contextTokens,
    maxOutputTokens: next.maxOutputTokens ?? base.maxOutputTokens,
    pricing: mergePricing(base.pricing, next.pricing),
    sources: Array.from(new Set([...base.sources, ...next.sources])),
  };
}

/** Apply a partial override on top of a resolved base (override wins per field). */
export function applyOverride(
  base: NormalizedModelInfo,
  override: ModelInfoOverride | undefined,
): NormalizedModelInfo {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    reasoningEfforts: override.reasoningEfforts
      ? dedupeEfforts(override.reasoningEfforts)
      : base.reasoningEfforts,
    pricing: mergePricing(base.pricing, override.pricing),
    sources: Array.from(new Set([...base.sources, "override"])),
  };
}
