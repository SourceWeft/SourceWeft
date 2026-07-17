import type { LlmExecutionConfig } from "../../content/model-gateway-audit";

const DEFAULT_PROFILE_ALIAS_BY_KIND = {
  image: "image-default",
  vision: "vision-default",
} as const;

function normalizeRequestedProfileAlias(
  kind: "image" | "vision",
  alias: string | null | undefined,
) {
  const trimmed = alias?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === DEFAULT_PROFILE_ALIAS_BY_KIND[kind]) {
    return null;
  }
  return trimmed;
}

function requestedGlobalProfileAlias(
  execution: LlmExecutionConfig | undefined,
): string | undefined {
  if (execution?.executionMode === "BYOK") {
    return undefined;
  }
  const alias = execution?.profileAlias?.trim();
  return alias || undefined;
}

export function resolveRequestedThreadProfileAlias(input: {
  execution?: LlmExecutionConfig;
  legacyProfileAlias?: string | null;
  kind: "image" | "vision";
}): { provided: boolean; profileAlias: string | null | undefined } {
  const executionProfileAlias = requestedGlobalProfileAlias(input.execution);
  const provided =
    executionProfileAlias !== undefined ||
    input.legacyProfileAlias !== undefined;
  if (!provided) {
    return { provided: false, profileAlias: undefined };
  }

  return {
    provided: true,
    profileAlias: normalizeRequestedProfileAlias(
      input.kind,
      executionProfileAlias ?? input.legacyProfileAlias,
    ),
  };
}
