import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { AgentToolTimeoutDefinition } from "@sourceweft/contracts/agent-tools";
import {
  resolveAgentToolTimeoutMs,
  withAgentToolHostInvocationSignal,
} from "@sourceweft/contracts/agent-tools";
import { getAgentToolDefinition } from "@sourceweft/agent-tool-registry";
import { createMiddleware } from "langchain";
import { runWithSourceWeftToolInvocationSignal } from "./tool-call-context";

/** Host-owned ceiling; a tool declaration can request less, never more. */
export const AGENT_TOOL_HOST_EXECUTION_TIMEOUT_MAX_MS = 10 * 60_000;

/** Time allowed for a signal-aware tool to finish cancellation and cleanup. */
export const AGENT_TOOL_TERMINATION_GRACE_MS = 30_000;

export const AGENT_TOOL_EXECUTION_TIMEOUT_CODE =
  "AGENT_TOOL_EXECUTION_TIMEOUT" as const;
export const AGENT_TOOL_TERMINATION_UNKNOWN_CODE =
  "AGENT_TOOL_TERMINATION_UNKNOWN" as const;

export type AgentToolExecutionTimeoutReason = Error & {
  readonly code: typeof AGENT_TOOL_EXECUTION_TIMEOUT_CODE;
  readonly timeoutMs: number;
  readonly toolName: string;
};

export type AgentToolTerminationUnknownReason = Error & {
  readonly code: typeof AGENT_TOOL_TERMINATION_UNKNOWN_CODE;
  readonly terminationGraceMs: number;
  readonly toolName: string;
};

/**
 * Stable timeout reason delivered through the Host invocation signal's
 * `reason` (resolved from ToolRuntime.configurable by the contracts helper).
 *
 * Capability code should inspect the structural fields rather than importing
 * this backend class. That keeps cancellation policy host-owned while allowing
 * a capability to translate the reason into its own public error vocabulary.
 */
export class AgentToolExecutionTimeoutError
  extends Error
  implements AgentToolExecutionTimeoutReason
{
  readonly code = AGENT_TOOL_EXECUTION_TIMEOUT_CODE;
  readonly timeoutMs: number;
  readonly toolName: string;
  override readonly name = "TimeoutError";

  constructor(input: { timeoutMs: number; toolName: string }) {
    super(
      `Agent tool '${input.toolName}' exceeded its ${input.timeoutMs}ms execution timeout.`,
    );
    this.timeoutMs = input.timeoutMs;
    this.toolName = input.toolName;
  }
}

/**
 * The timeout/cancel signal was delivered but the handler did not finish its
 * cleanup within the bounded host grace period. This is intentionally distinct
 * from a confirmed timeout so callers never claim remote termination happened.
 */
export class AgentToolTerminationUnknownError
  extends Error
  implements AgentToolTerminationUnknownReason
{
  readonly code = AGENT_TOOL_TERMINATION_UNKNOWN_CODE;
  readonly terminationGraceMs: number;
  readonly toolName: string;
  override readonly name = "AgentToolTerminationUnknownError";

  constructor(input: {
    cause: unknown;
    terminationGraceMs: number;
    toolName: string;
  }) {
    super(
      `Agent tool '${input.toolName}' did not confirm termination within ${input.terminationGraceMs}ms.`,
      { cause: input.cause },
    );
    this.terminationGraceMs = input.terminationGraceMs;
    this.toolName = input.toolName;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function isAgentToolExecutionTimeoutReason(
  value: unknown,
): value is AgentToolExecutionTimeoutReason {
  if (!isObject(value)) return false;
  return (
    value.name === "TimeoutError" &&
    value.code === AGENT_TOOL_EXECUTION_TIMEOUT_CODE &&
    typeof value.timeoutMs === "number" &&
    Number.isFinite(value.timeoutMs) &&
    typeof value.toolName === "string" &&
    value.toolName.length > 0
  );
}

export function isAgentToolTerminationUnknownReason(
  value: unknown,
): value is AgentToolTerminationUnknownReason {
  if (!isObject(value)) return false;
  return (
    value.name === "AgentToolTerminationUnknownError" &&
    value.code === AGENT_TOOL_TERMINATION_UNKNOWN_CODE &&
    typeof value.terminationGraceMs === "number" &&
    Number.isFinite(value.terminationGraceMs) &&
    typeof value.toolName === "string" &&
    value.toolName.length > 0
  );
}

/** Resolve a termination-unknown reason through LangChain middleware wrappers. */
export function findAgentToolTerminationUnknownReason(
  value: unknown,
): AgentToolTerminationUnknownReason | null {
  const visited = new Set<unknown>();
  let current = value;
  while (isObject(current) && !visited.has(current)) {
    if (isAgentToolTerminationUnknownReason(current)) return current;
    visited.add(current);
    current = current.cause;
  }
  return null;
}

function validateTerminationGraceMs(value: number) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(
      "Agent tool termination grace must be a positive finite integer.",
    );
  }
  return value;
}

function hasTerminationUnknownCode(value: unknown) {
  const visited = new Set<unknown>();
  let current = value;
  while (isObject(current) && !visited.has(current)) {
    if (
      current.code === AGENT_TOOL_TERMINATION_UNKNOWN_CODE ||
      current.code === "SANDBOX_TERMINATION_UNKNOWN"
    ) {
      return true;
    }
    visited.add(current);
    current = current.cause;
  }
  return false;
}

type ToolSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly error: unknown; readonly kind: "rejected" };

type AbortTrigger = {
  readonly kind: "aborted";
  readonly reason: unknown;
  readonly source: "caller" | "timeout";
};

type GraceExpired = { readonly kind: "grace_expired" };

function settle<T>(promise: Promise<T>): Promise<ToolSettlement<T>> {
  return promise.then(
    (value) => ({ kind: "fulfilled", value }),
    (error: unknown) => ({ error, kind: "rejected" }),
  );
}

function callerAbortReason(signal: AbortSignal) {
  return (
    signal.reason ??
    new DOMException("Agent tool invocation was cancelled.", "AbortError")
  );
}

type InvokableTool = (ClientTool | ServerTool) & {
  invoke: (
    input: unknown,
    config?: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
};

function hasInvoke(tool: ClientTool | ServerTool): tool is InvokableTool {
  return typeof (tool as { invoke?: unknown }).invoke === "function";
}

/**
 * LangChain's ToolNode currently builds the actual ToolRuntime signal from its
 * closed-over run config, not from an overridden middleware `request.runtime`.
 * The documented dynamic-tool override seam is therefore used to delegate the
 * original tool with the invocation signal. The signal travels through a
 * Host-owned configurable side channel instead of RunnableConfig.signal:
 * LangChain races the latter and rejects `invoke()` before the underlying tool
 * callback has finished cleanup. A Proxy preserves the tool's prototype,
 * schema and metadata while intercepting only `invoke`.
 */
function toolWithInvocationSignal<T extends ClientTool | ServerTool>(
  tool: T,
  signal: AbortSignal,
): T {
  if (!hasInvoke(tool)) return tool;
  const invoke = (
    invocationInput: unknown,
    config?: Record<string, unknown>,
  ) => {
    // Never hand the invocation signal to LangChain's automatic Promise race.
    // The capability reads the same signal structurally from configurable and
    // settles only after its own cancellation/cleanup protocol has completed.
    const { signal: _langChainSignal, ...configWithoutSignal } = config ?? {};
    return Reflect.apply(tool.invoke, tool, [
      invocationInput,
      withAgentToolHostInvocationSignal(configWithoutSignal, signal),
    ]);
  };

  return new Proxy(tool, {
    get(target, property) {
      if (property === "invoke") return invoke;
      return Reflect.get(target, property, target);
    },
  });
}

function rethrowSettlement<T>(settlement: ToolSettlement<T>): T {
  if (settlement.kind === "rejected") throw settlement.error;
  return settlement.value;
}

export type SourceWeftToolExecutionTimeoutMiddlewareInput = {
  /** Production leaves this at the host hard ceiling; injectable for tests. */
  readonly hostMaxMs?: number;
  /** Production cancellation/cleanup grace; injectable for deterministic tests. */
  readonly terminationGraceMs?: number;
  /** Registry lookup seam for isolated policy tests. */
  readonly resolveDefinition?: (
    toolName: string,
  ) => AgentToolTimeoutDefinition | null;
};

/**
 * Enforces the registered, host-clamped wall-clock budget for every tool call.
 *
 * Arguments are deliberately absent from timeout resolution. On expiry the
 * timer aborts the exact signal seen by the tool, then waits for the handler to
 * finish cancellation/cleanup. A handler that ignores the signal becomes
 * `termination_unknown` after the bounded grace; it is never reported as a
 * confirmed timeout or allowed to return a late success.
 */
export function createSourceWeftToolExecutionTimeoutMiddleware(
  input: SourceWeftToolExecutionTimeoutMiddlewareInput = {},
) {
  const hostMaxMs = input.hostMaxMs ?? AGENT_TOOL_HOST_EXECUTION_TIMEOUT_MAX_MS;
  const terminationGraceMs = validateTerminationGraceMs(
    input.terminationGraceMs ?? AGENT_TOOL_TERMINATION_GRACE_MS,
  );
  const resolveDefinition = input.resolveDefinition ?? getAgentToolDefinition;

  // Validate host policy when the stack is built, not on the first invocation.
  resolveAgentToolTimeoutMs({
    definition: { id: "__sourceweft_host_default__" },
    hostMaxMs,
  });

  return createMiddleware({
    name: "SourceWeftToolExecutionTimeout",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall.name;
      const timeoutMs = resolveAgentToolTimeoutMs({
        definition: resolveDefinition(toolName) ?? { id: toolName },
        hostMaxMs,
      });
      const callerSignal = request.runtime.signal;
      if (callerSignal?.aborted) {
        throw callerAbortReason(callerSignal);
      }

      const invocationController = new AbortController();
      let resolveAbort!: (trigger: AbortTrigger) => void;
      const abortPromise = new Promise<AbortTrigger>((resolve) => {
        resolveAbort = resolve;
      });
      let abortTrigger: AbortTrigger | null = null;
      const triggerAbort = (trigger: AbortTrigger) => {
        if (abortTrigger) return;
        abortTrigger = trigger;
        invocationController.abort(trigger.reason);
        resolveAbort(trigger);
      };
      const onCallerAbort = () => {
        if (!callerSignal) return;
        triggerAbort({
          kind: "aborted",
          reason: callerAbortReason(callerSignal),
          source: "caller",
        });
      };
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

      const timeoutReason = new AgentToolExecutionTimeoutError({
        timeoutMs,
        toolName,
      });
      const timeoutHandle = setTimeout(() => {
        triggerAbort({
          kind: "aborted",
          reason: timeoutReason,
          source: "timeout",
        });
      }, timeoutMs);

      let handlerPromise: Promise<Awaited<ReturnType<typeof handler>>>;
      try {
        const tool = request.tool
          ? toolWithInvocationSignal(request.tool, invocationController.signal)
          : request.tool;
        handlerPromise = Promise.resolve(
          runWithSourceWeftToolInvocationSignal(
            invocationController.signal,
            () =>
              handler({
                ...request,
                runtime: {
                  ...request.runtime,
                  signal: invocationController.signal,
                },
                tool,
              }),
          ),
        );
      } catch (error) {
        handlerPromise = Promise.reject(error);
      }

      const settlementPromise = settle(handlerPromise);
      const clearInvocationResources = () => {
        clearTimeout(timeoutHandle);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      };

      const first = await Promise.race([settlementPromise, abortPromise]);
      if (first.kind !== "aborted") {
        clearInvocationResources();
        return rethrowSettlement(first);
      }

      // Do not return from a Promise.race while provider/tool cleanup continues.
      // Settlement means the signal-aware handler finished its own termination
      // protocol; grace expiry is explicitly an unknown termination state.
      let graceHandle: ReturnType<typeof setTimeout> | undefined;
      const graceExpired = new Promise<GraceExpired>((resolve) => {
        graceHandle = setTimeout(
          () => resolve({ kind: "grace_expired" }),
          terminationGraceMs,
        );
      });
      const afterAbort = await Promise.race([settlementPromise, graceExpired]);
      if (graceHandle) clearTimeout(graceHandle);
      clearInvocationResources();

      if (afterAbort.kind === "grace_expired") {
        throw new AgentToolTerminationUnknownError({
          cause: first.reason,
          terminationGraceMs,
          toolName,
        });
      }

      if (
        afterAbort.kind === "rejected" &&
        hasTerminationUnknownCode(afterAbort.error)
      ) {
        throw new AgentToolTerminationUnknownError({
          cause: first.reason,
          terminationGraceMs,
          toolName,
        });
      }

      // Once abort won the race, even a handler that swallows the signal and
      // returns success cannot publish a late success back into the Agent graph.
      throw first.reason;
    },
  });
}
