import { SandboxInstanceChangedError } from "./errors";
import { randomUUID } from "node:crypto";
import type { SandboxManager } from "./sandbox-manager";
import type {
  SandboxCancellationReason,
  SandboxCancellationResult,
  SandboxRef,
  SandboxRuntimeContext,
} from "./types";

export function pinnedOperationCancellationReason(
  signal?: AbortSignal,
): SandboxCancellationReason {
  const reason = signal?.reason;
  const record =
    reason && typeof reason === "object"
      ? (reason as Record<string, unknown>)
      : null;
  const marker = [record?.name, record?.code, record?.message, reason]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return marker.includes("timeout") || marker.includes("timed_out")
    ? "timed_out"
    : "user_cancelled";
}

export function isPinnedOperationProviderTimeout(error: unknown) {
  return (
    error instanceof Error && error.message.includes("SANDBOX_COMMAND_TIMEOUT")
  );
}

type PinnedOperationOutcome<T> =
  | { readonly kind: "result"; readonly result: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "aborted" };

/**
 * Run one file/command-backed operation against a fixed sandbox generation.
 *
 * File APIs do not expose a provider command handle, so cancellation always
 * deletes the pinned sandbox and waits for physical confirmation. A result is
 * accepted only while the same durable generation is still ready.
 */
export async function runPinnedSandboxOperation<T>(input: {
  readonly manager: SandboxManager;
  readonly context: SandboxRuntimeContext;
  readonly sandbox: SandboxRef;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly timeoutMessage: string;
  readonly invalidStateMessage: string;
  readonly createAbortError: (input: {
    cancellation: SandboxCancellationResult;
    reason: SandboxCancellationReason;
  }) => Error;
  readonly createDiscardedError: () => Error;
  readonly operation: (options: {
    executionId: string;
    signal: AbortSignal;
    timeoutMs: number;
  }) => Promise<T>;
}): Promise<T> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0
  ) {
    throw new Error("SANDBOX_PINNED_OPERATION_TIMEOUT_INVALID");
  }

  const executionId = randomUUID();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) {
    forwardAbort();
  } else {
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeoutHandle = setTimeout(
    () =>
      controller.abort(new DOMException(input.timeoutMessage, "TimeoutError")),
    input.timeoutMs,
  );
  timeoutHandle.unref?.();

  let cancellationRun: Promise<SandboxCancellationResult> | undefined;
  const beginCancellation = (reason: SandboxCancellationReason) => {
    cancellationRun ??= input.manager
      .cancelExecution({
        sandbox: input.sandbox,
        executionId,
        reason,
        forceSandbox: true,
      })
      .catch((): SandboxCancellationResult => ({
        confirmed: false,
        mode: "unknown",
      }));
    return cancellationRun;
  };
  const onAbort = () => {
    void beginCancellation(
      pinnedOperationCancellationReason(controller.signal),
    );
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();

  const operation: Promise<PinnedOperationOutcome<T>> = Promise.resolve()
    .then(() =>
      input.operation({
        executionId,
        signal: controller.signal,
        timeoutMs: input.timeoutMs,
      }),
    )
    .then(
      (result) => ({ kind: "result", result }),
      (error: unknown) => ({ kind: "error", error }),
    );
  const aborted = new Promise<PinnedOperationOutcome<T>>((resolve) => {
    if (controller.signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => resolve({ kind: "aborted" }),
      { once: true },
    );
  });

  const cancelAndThrow = async (
    reason: SandboxCancellationReason,
  ): Promise<never> => {
    const cancellation = await beginCancellation(reason);
    throw input.createAbortError({ cancellation, reason });
  };

  try {
    const outcome = await Promise.race([operation, aborted]);
    if (controller.signal.aborted || outcome.kind === "aborted") {
      return cancelAndThrow(
        pinnedOperationCancellationReason(controller.signal),
      );
    }
    if (
      outcome.kind === "error" &&
      isPinnedOperationProviderTimeout(outcome.error)
    ) {
      return cancelAndThrow("timed_out");
    }
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind !== "result") {
      throw new Error(input.invalidStateMessage);
    }

    const disposition = await input.manager.resolveExecutionResultDisposition(
      input.sandbox,
      input.context,
    );
    if (controller.signal.aborted) {
      return cancelAndThrow(
        pinnedOperationCancellationReason(controller.signal),
      );
    }
    if (disposition === "instance_changed")
      throw new SandboxInstanceChangedError();
    if (disposition === "termination_unknown") {
      throw input.createAbortError({
        cancellation: { confirmed: false, mode: "unknown" },
        reason: "user_cancelled",
      });
    }
    if (disposition === "sandbox_terminated") {
      throw input.createDiscardedError();
    }
    return outcome.result;
  } finally {
    clearTimeout(timeoutHandle);
    controller.signal.removeEventListener("abort", onAbort);
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}
