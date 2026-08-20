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

/** Per-token USD prices (image/second priced per unit). Null = unknown. */
export interface ModelPricingInfo {
  inputPerToken?: number | null;
  outputPerToken?: number | null;
  cacheReadPerToken?: number | null;
  cacheWritePerToken?: number | null;
  reasoningOutputPerToken?: number | null;
  audioInputPerToken?: number | null;
  audioOutputPerToken?: number | null;
  inputPerImage?: number | null;
  outputPerImage?: number | null;
}

export interface NormalizedModelInfo {
  /** Canonical model id (provider/model or bare), lowercased. */
  id: string;
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
    pricing:
      next.pricing || base.pricing
        ? { ...base.pricing, ...next.pricing }
        : undefined,
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
    pricing:
      override.pricing || base.pricing
        ? { ...base.pricing, ...override.pricing }
        : undefined,
    sources: Array.from(new Set([...base.sources, "override"])),
  };
}
