import type {
  AgentTurnTool,
  CapabilityAgentToolCategory,
  CapabilityAgentToolEntry,
  CapabilityAgentToolFactoryResult,
} from "./types";

/**
 * A factory may return a bare array of tools or an object carrying prompt
 * providers alongside them; both forms exist because the simple case should not
 * have to declare an empty `promptProviders`. This collapses the two into one.
 */
export function normalizeFactoryResult(
  result: CapabilityAgentToolFactoryResult,
) {
  if (Array.isArray(result)) {
    return {
      promptProviders: [],
      tools: result.map(normalizeToolEntry),
    };
  }
  const resultObject = result as Exclude<
    CapabilityAgentToolFactoryResult,
    readonly CapabilityAgentToolEntry[]
  >;
  return {
    promptProviders: [...(resultObject.promptProviders ?? [])],
    tools: (resultObject.tools ?? []).map(normalizeToolEntry),
  };
}

/**
 * Categories default to none, deliberately.
 *
 * A category is not a permission and not a binding decision: an uncategorized
 * tool is still bound and still callable. All the category lists do is tell the
 * runtime prompt which tools count as web tools and which produce artifacts, so
 * the fail-open default costs a prompt hint, never a capability. The
 * alternative — refusing to bind a tool that declared no category — would take
 * a whole capability off a turn over a missing label, and the bare
 * `StructuredToolInterface` form of an entry has no way to declare one at all.
 */
export function normalizeToolEntry(entry: CapabilityAgentToolEntry): {
  readonly categories: readonly CapabilityAgentToolCategory[];
  readonly tool: AgentTurnTool;
} {
  if ("tool" in entry) {
    return {
      categories: entry.categories ?? [],
      tool: entry.tool,
    };
  }
  return {
    categories: [],
    tool: entry,
  };
}
