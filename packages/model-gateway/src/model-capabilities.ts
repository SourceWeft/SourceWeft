import type {
  ModelCapabilities,
  ModelCapabilityRule,
  StructuredOutputConfig,
} from "./types";

type StructuredOutputMethod = NonNullable<StructuredOutputConfig["method"]>;

const DEFAULTS: ModelCapabilities = {
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
 * Strip disabled params from a request kwargs object — the JS mirror of
 * langchain-python's `ChatOpenAI._filter_disabled_params`. For each entry in
 * `disabledParams`: `null` removes the param entirely; a list removes it only
 * when the param's current value is one of the listed values. Provider-agnostic
 * and value-general (any param). Returns the same reference when nothing changed.
 */
export function filterDisabledParams(
  kwargs: Record<string, unknown> | undefined,
  disabledParams: Record<string, null | readonly unknown[]> | undefined,
): Record<string, unknown> | undefined {
  if (!kwargs || !disabledParams) {
    return kwargs;
  }
  let out: Record<string, unknown> | undefined;
  for (const [param, disabled] of Object.entries(disabledParams)) {
    if (!(param in kwargs)) {
      continue;
    }
    const drop =
      disabled === null ||
      (Array.isArray(disabled) && disabled.includes(kwargs[param]));
    if (drop) {
      out ??= { ...kwargs };
      delete out[param];
    }
  }
  return out ?? kwargs;
}

/**
 * Whether a forced `tool_choice` may be sent to the model. False when
 * `tool_choice` is disabled entirely (`disabledParams: { tool_choice: null }`) —
 * not sending it defaults the API to `auto` (an available tool). Drives the
 * structured-output strategy (availableTool when forcing is off), mirroring
 * langchain-python defaulting `function_calling` once the disabled tool_choice
 * is dropped.
 */
export function forcedToolChoiceDisabled(
  disabledParams: Record<string, null | readonly unknown[]> | undefined,
): boolean {
  return disabledParams?.tool_choice === null;
}
