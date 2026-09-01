import { z } from "zod";

/** Default wall-clock budget for an Agent tool that declares no override. */
export const AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS = 120_000;

/** Smallest timeout accepted from either a tool definition or host policy. */
export const AGENT_TOOL_EXECUTION_TIMEOUT_MIN_MS = 1_000;

/**
 * Reserved RunnableConfig.configurable key for the host-owned invocation
 * signal. It intentionally does not use RunnableConfig.signal: LangChain's
 * `tool()` wrapper races that field and settles its public promise before the
 * underlying callback has finished cancellation and cleanup.
 */
export const AGENT_TOOL_HOST_INVOCATION_SIGNAL_KEY =
  "__sourceweft_agent_tool_invocation_signal" as const;

function objectRecord(value: unknown): Record<PropertyKey, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<PropertyKey, unknown>)
    : null;
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  const record = objectRecord(value);
  return (
    record !== null &&
    typeof record.aborted === "boolean" &&
    typeof record.addEventListener === "function" &&
    typeof record.removeEventListener === "function"
  );
}

/**
 * Read the host invocation signal from a LangChain ToolRuntime-shaped value.
 *
 * This remains structural so capability contracts do not import LangChain and
 * so tests/adapters can pass the same runtime shape. Both locations are
 * accepted because LangChain exposes RunnableConfig directly to tool callbacks,
 * while a few host adapters retain it under `config`.
 */
export function resolveAgentToolHostInvocationSignal(
  runtime: unknown,
): AbortSignal | undefined {
  const record = objectRecord(runtime);
  const nestedConfig = objectRecord(record?.config);
  const configurableCandidates = [
    objectRecord(record?.configurable),
    objectRecord(nestedConfig?.configurable),
  ];
  for (const configurable of configurableCandidates) {
    const candidate = configurable?.[AGENT_TOOL_HOST_INVOCATION_SIGNAL_KEY];
    if (isAbortSignalLike(candidate)) return candidate;
  }
  return undefined;
}

/** Attach the host invocation signal without disturbing other config keys. */
export function withAgentToolHostInvocationSignal<
  Config extends Record<string, unknown>,
>(config: Config | undefined, signal: AbortSignal): Config {
  const base = config ?? ({} as Config);
  const configurable = objectRecord(base.configurable) ?? {};
  return {
    ...base,
    configurable: {
      ...configurable,
      [AGENT_TOOL_HOST_INVOCATION_SIGNAL_KEY]: signal,
    },
  };
}

/**
 * A timeout declaration is configuration, not model input. Keep it integral so
 * every host and provider observes the same millisecond boundary.
 */
export const agentToolExecutionTimeoutMsSchema = z
  .number()
  .finite()
  .int()
  .min(AGENT_TOOL_EXECUTION_TIMEOUT_MIN_MS);

export type AgentToolTimeoutDefinition = {
  /** Required definition identity keeps this API anchored to registry data. */
  readonly id: string;
  readonly executionTimeoutMs?: number;
};

export type ResolveAgentToolTimeoutInput = {
  /** The registered definition; invocation arguments are deliberately absent. */
  readonly definition: AgentToolTimeoutDefinition;
  /** Host-owned hard ceiling. Tool declarations may never raise it. */
  readonly hostMaxMs: number;
  /** Primarily available for hosts with a deliberately smaller default. */
  readonly globalDefaultMs?: number;
};

/**
 * Resolve one tool invocation's wall-clock budget from trusted policy only.
 *
 * Invalid policy fails fast. A valid declaration above the host ceiling is
 * clamped because the declaration is a request while the host owns authority.
 */
export function resolveAgentToolTimeoutMs(
  input: ResolveAgentToolTimeoutInput,
): number {
  const hostMaxMs = agentToolExecutionTimeoutMsSchema.parse(input.hostMaxMs);
  const globalDefaultMs = agentToolExecutionTimeoutMsSchema.parse(
    input.globalDefaultMs ?? AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS,
  );
  const declaredTimeoutMs =
    input.definition.executionTimeoutMs === undefined
      ? globalDefaultMs
      : agentToolExecutionTimeoutMsSchema.parse(
          input.definition.executionTimeoutMs,
        );

  return Math.min(declaredTimeoutMs, hostMaxMs);
}
