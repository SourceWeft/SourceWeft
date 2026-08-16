import type {
  ModelCapabilities,
  ModelCapabilityRule,
  StructuredOutputConfig,
  ThinkingMode,
} from "./types";

type StructuredOutputMethod = NonNullable<StructuredOutputConfig["method"]>;

const DEFAULTS: ModelCapabilities = {
  supportsForcedToolChoice: true,
  forcedToolChoiceBlockedByThinking: false,
  toolCallArgumentJsonRepair: false,
};

/**
 * Resolves capabilities for a model from the config-supplied rules. Rules are
 * walked in order (deployment overrides first, shipped defaults last); the first
 * rule that sets a flag wins, and unset flags fall to {@link DEFAULTS}. The
 * package holds no model names — they live in the rules the config supplies.
 */
export function resolveModelCapabilities(
  providerModel: string,
  rules: readonly ModelCapabilityRule[] | undefined,
): ModelCapabilities {
  const resolved: ModelCapabilities = { ...DEFAULTS };
  if (!rules || rules.length === 0) {
    return resolved;
  }
  const model = providerModel.toLowerCase();
  const set = new Set<keyof ModelCapabilities>();
  for (const rule of rules) {
    if (!model.includes(rule.modelMatch.toLowerCase())) {
      continue;
    }
    for (const key of Object.keys(rule.capabilities) as Array<
      keyof ModelCapabilities
    >) {
      const value = rule.capabilities[key];
      if (value !== undefined && !set.has(key)) {
        // key is a dynamic keyof, so the field's specific type collapses to
        // `never` under indexing; the value is the matching union member.
        (resolved as Record<keyof ModelCapabilities, unknown>)[key] = value;
        set.add(key);
      }
    }
  }
  return resolved;
}

/**
 * The structured-output strategy for a request, resolved from capabilities ahead
 * of execution so the bridge follows a plan instead of judging inline.
 *
 * - `structured`: LangChain's `withStructuredOutput`. `method` undefined lets
 *   LangChain pick per model; a caller-pinned method is passed through.
 * - `availableTool`: bind the schema as an *available* tool — for models that
 *   reject a forced `tool_choice`. Mirrors what Python LangChain's
 *   `ChatOpenAI.with_structured_output` (function_calling) produces once
 *   `_filter_disabled_params` drops a disabled `tool_choice`: the tool is bound
 *   with `parallel_tool_calls: false` and *no* `tool_choice` (API default auto).
 */
export type StructuredOutputPlan =
  | { strategy: "structured"; method?: StructuredOutputMethod; strict?: boolean }
  | { strategy: "availableTool"; strict?: boolean };

export function planStructuredOutput(input: {
  /** Caller-pinned method, if any (authoritative — capability plays no part). */
  method?: StructuredOutputMethod;
  strict?: boolean;
  supportsForcedToolChoice: boolean;
}): StructuredOutputPlan {
  if (input.method) {
    return {
      strategy: "structured",
      method: input.method,
      ...(input.strict !== undefined ? { strict: input.strict } : {}),
    };
  }
  if (!input.supportsForcedToolChoice) {
    return {
      strategy: "availableTool",
      ...(input.strict !== undefined ? { strict: input.strict } : {}),
    };
  }
  return { strategy: "structured" };
}

/**
 * Whether a forced `tool_choice` may actually be sent on *this* request —
 * `supportsForcedToolChoice` refined by the thinking-conditional restriction.
 *
 * A `forcedToolChoiceBlockedByThinking` model regains forced tool_choice only
 * when both hold: the request's thinking mode is `"off"`, and the adapter's
 * "off" is a hard provider-level disable (`guaranteesThinkingDisable`). "auto"
 * counts as thinking ON for such models — thinking-by-default is precisely why
 * the flag exists — and a best-effort disable (OpenRouter fan-out) must not be
 * trusted with a forced choice the upstream may still 400 on.
 */
export function effectiveForcedToolChoiceSupport(input: {
  capabilities: Pick<
    ModelCapabilities,
    "supportsForcedToolChoice" | "forcedToolChoiceBlockedByThinking"
  >;
  thinkingMode: ThinkingMode;
  adapterGuaranteesThinkingDisable: boolean;
}): boolean {
  if (!input.capabilities.supportsForcedToolChoice) {
    return false;
  }
  if (!input.capabilities.forcedToolChoiceBlockedByThinking) {
    return true;
  }
  return (
    input.thinkingMode === "off" && input.adapterGuaranteesThinkingDisable
  );
}

/**
 * A `tool_choice` that forces the model to call a tool: `"required"`/`"any"`, a
 * bare tool name, or a `{type:"function"|"tool", ...}` object. `"auto"`/`"none"`
 * (and unset) leave the model free and are never forced.
 */
function isForcedToolChoice(toolChoice: unknown): boolean {
  if (typeof toolChoice === "string") {
    return toolChoice !== "auto" && toolChoice !== "none";
  }
  return (
    typeof toolChoice === "object" &&
    toolChoice !== null &&
    !Array.isArray(toolChoice)
  );
}

/**
 * Downgrade a forced `tool_choice` to `"auto"` when the model rejects a forced
 * one — the request-wide analogue of {@link planStructuredOutput}'s strategy,
 * matching LiteLLM's request-level `drop_params` handling (LangChain scopes its
 * `disabled_params` to `with_structured_output` only). A no-op when forced
 * tool_choice is supported and for non-forcing values.
 */
export function normalizeToolChoiceForModel(input: {
  toolChoice: unknown;
  supportsForcedToolChoice: boolean;
}): unknown {
  if (input.supportsForcedToolChoice || !isForcedToolChoice(input.toolChoice)) {
    return input.toolChoice;
  }
  return "auto";
}

/**
 * Apply {@link normalizeToolChoiceForModel} to a bindTools kwargs object,
 * returning it unchanged (same reference) when nothing needs downgrading.
 * `supportsForcedToolChoice` is the *effective* support for this request —
 * callers resolve it via {@link effectiveForcedToolChoiceSupport}.
 */
export function downgradeForcedToolChoiceInKwargs(
  kwargs: Record<string, unknown> | undefined,
  supportsForcedToolChoice: boolean,
): Record<string, unknown> | undefined {
  if (!kwargs || !("tool_choice" in kwargs)) {
    return kwargs;
  }
  const normalized = normalizeToolChoiceForModel({
    toolChoice: kwargs.tool_choice,
    supportsForcedToolChoice,
  });
  return normalized === kwargs.tool_choice
    ? kwargs
    : { ...kwargs, tool_choice: normalized };
}
