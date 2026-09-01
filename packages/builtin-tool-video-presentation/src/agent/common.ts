import { createHash } from "node:crypto";
import type { ToolRuntime } from "langchain";
import type {
  AgentToolLlmExecutionConfig,
  AgentToolModelProfileView,
} from "@sourceweft/contracts/agent-tools";
import { resolveAgentToolHostInvocationSignal } from "@sourceweft/contracts/agent-tools";
export { VIDEO_PRESENTATION_BUILDER_VERSION } from "@sourceweft/contracts/video-presentation";
import {
  normalizeGatewayError,
  type GatewayErrorCode,
  type GatewayExecutionInput,
} from "@sourceweft/model-gateway";

export const VIDEO_PRESENTATION_SOURCE_FILE = "video-presentation.draft.json";

export function resolveVideoToolAbortSignal(runtime: ToolRuntime) {
  return resolveAgentToolHostInvocationSignal(runtime);
}

export function throwVideoToolAbortReason(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("The tool invocation was aborted.", "AbortError")
  );
}

export function resolveVideoToolCallId(runtime: ToolRuntime) {
  const value = runtime as ToolRuntime & {
    config?: { toolCall?: { id?: unknown } };
    toolCall?: { id?: unknown };
    toolCallId?: unknown;
  };
  const candidate =
    value.toolCallId ?? value.toolCall?.id ?? value.config?.toolCall?.id;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(
      "VIDEO_PRESENTATION_TOOL_CALL_ID_REQUIRED: durable tool identity is missing",
    );
  }
  return candidate;
}

export function sha256Digest(bytes: Uint8Array | string) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalFileTreeDigest(
  files: readonly { path: string; bytes: Uint8Array }[],
) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(`${file.path.length}:${file.path}\0`);
    hash.update(`${file.bytes.byteLength}:`);
    hash.update(file.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export type VideoGatewayExecution = GatewayExecutionInput & {
  readonly model: string;
  readonly fallbackPolicy: "none";
};

function nonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * One projection from preflight identity to a model-gateway request. Every Video
 * provider call uses it, so BYOK routing fields and the no-fallback guarantee
 * cannot drift independently between image and narration.
 */
export function resolveVideoGatewayExecution(
  profile: AgentToolModelProfileView,
  execution?: AgentToolLlmExecutionConfig,
): VideoGatewayExecution {
  const executionMode = execution?.executionMode ?? "GLOBAL";
  const model =
    executionMode === "BYOK"
      ? (nonEmpty(execution?.providerModel) ??
        nonEmpty(execution?.modelAlias) ??
        nonEmpty(execution?.byokModelId) ??
        profile.modelAlias)
      : profile.modelAlias;
  return {
    model,
    fallbackPolicy: "none",
    executionMode,
    ...(executionMode === "GLOBAL"
      ? { profileAlias: profile.profileAlias }
      : {}),
    ...(nonEmpty(execution?.providerHint)
      ? { providerHint: nonEmpty(execution?.providerHint) }
      : {}),
    ...(nonEmpty(execution?.byokModelId)
      ? { byokModelId: nonEmpty(execution?.byokModelId) }
      : {}),
    ...(nonEmpty(execution?.credentialId)
      ? { credentialId: nonEmpty(execution?.credentialId) }
      : {}),
    ...(execution?.byok ? { byok: execution.byok } : {}),
  };
}

/** Secret-free identity used inside semantic keys. */
export function videoModelSemanticIdentity(
  profile: AgentToolModelProfileView,
  execution?: AgentToolLlmExecutionConfig,
) {
  const resolved = resolveVideoGatewayExecution(profile, execution);
  return {
    gatewayConfigId: profile.gatewayConfigId,
    profileAlias: profile.profileAlias,
    model: resolved.model,
    executionMode: resolved.executionMode ?? "GLOBAL",
    ...(resolved.providerHint ? { providerHint: resolved.providerHint } : {}),
    ...(resolved.byokModelId ? { byokModelId: resolved.byokModelId } : {}),
    ...(resolved.credentialId ? { credentialId: resolved.credentialId } : {}),
    ...(resolved.byok?.provider
      ? { byokProvider: resolved.byok.provider }
      : {}),
    ...(resolved.byok?.providerKind
      ? { byokProviderKind: resolved.byok.providerKind }
      : {}),
    ...(resolved.byok?.baseUrl ? { byokBaseUrl: resolved.byok.baseUrl } : {}),
  };
}

export type VideoSemanticFailureObservation = {
  readonly status: "failed";
  readonly code: string;
  readonly message: string;
};

const KNOWN_PROVIDER_FAILURE_CODES: ReadonlySet<GatewayErrorCode> = new Set([
  "AUTH",
  "BAD_REQUEST",
  "POLICY",
  "QUOTA",
  "RATE_LIMIT",
  "STRUCTURED_OUTPUT",
]);

/**
 * Failures known to have no retryable/unknown provider outcome become durable
 * failed observations. Timeout/upstream/unknown remain fenced unknown: replaying
 * those could duplicate a provider side effect.
 */
export function knownVideoProviderFailure(input: {
  error: unknown;
  codePrefix: "VIDEO_ASSET" | "VIDEO_NARRATION" | "VIDEO_VALIDATION";
  providerLabel: "image" | "narration" | "visual validation";
}): VideoSemanticFailureObservation | null {
  const normalized = normalizeGatewayError(input.error);
  if (!KNOWN_PROVIDER_FAILURE_CODES.has(normalized.code)) {
    return null;
  }
  return {
    status: "failed",
    code: `${input.codePrefix}_PROVIDER_${normalized.code}`,
    message: `The ${input.providerLabel} provider rejected the request (${normalized.code}).`,
  };
}

export function videoSemanticFailure(
  code: string,
  message: string,
): VideoSemanticFailureObservation {
  return { status: "failed", code, message };
}

export function videoToolBlocked(input: {
  code: string;
  message: string;
  diagnostics?: Array<Record<string, unknown>>;
}) {
  return {
    status: "blocked" as const,
    code: input.code,
    message: input.message,
    diagnostics: input.diagnostics ?? [],
  };
}
