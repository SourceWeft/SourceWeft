import { InvalidUpdateError } from "@langchain/langgraph";
import { ContentError } from "../../../content/errors";

/** Keep graph state conflicts separate from provider/tool argument failures. */
export function agentStateUpdateError(
  error: unknown,
  seen = new Set<unknown>(),
): ContentError | null {
  if (!error || typeof error !== "object" || seen.has(error)) return null;
  seen.add(error);
  // Preserve cancellation, billing and the trusted summary-stop error identity.
  if (error instanceof ContentError) return null;
  if (error instanceof InvalidUpdateError) {
    const failure = new ContentError(
      500,
      "AGENT_STATE_UPDATE_CONFLICT",
      "The run could not save its internal progress state. Please try again.",
      { recoverable: false, details: { retryable: false } },
    );
    Object.defineProperty(failure, "cause", {
      value: error,
      enumerable: false,
    });
    return failure;
  }
  const wrapped = error as { cause?: unknown; error?: unknown };
  return (
    agentStateUpdateError(wrapped.cause, seen) ??
    agentStateUpdateError(wrapped.error, seen)
  );
}
