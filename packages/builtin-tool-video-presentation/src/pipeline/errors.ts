import { DeliverablePipelineError } from "@sourceweft/capability-contracts";
import { VIDEO_PRESENTATION_ERROR_CODES } from "@sourceweft/contracts/video-presentation";

const {
  sandboxUnavailable: VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE,
  sandboxExecutionFailed: VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED,
} = VIDEO_PRESENTATION_ERROR_CODES;

export function videoPresentationProviderError(code: string, message: string) {
  return new DeliverablePipelineError({
    code,
    message,
    category: "provider",
    retryable: false,
  });
}

export function videoPresentationSandboxError(code: string, message: string) {
  return new DeliverablePipelineError({
    code,
    message,
    category: "sandbox",
    retryable: false,
  });
}

/**
 * Structural check (never instanceof): the host may load this package from a
 * separate module graph, so sandbox errors are recognized by their code.
 */
export function isVideoPresentationSandboxError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as { code?: unknown }).code ===
      VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE ||
      (error as { code?: unknown }).code ===
        VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED)
  );
}
