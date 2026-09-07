import { ModelGatewayError } from "./errors";
import type { GatewayProviderConfig, ResolvedRequestTarget } from "./types";

export function hasConfiguredCredentialHeaders(
  provider: Pick<GatewayProviderConfig, "apiKeyHeaderName" | "defaultHeaders">,
) {
  const names = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "api-key",
    "x-api-key",
  ]);
  if (provider.apiKeyHeaderName)
    names.add(provider.apiKeyHeaderName.trim().toLowerCase());
  return Object.keys(provider.defaultHeaders ?? {}).some((key) =>
    names.has(key.trim().toLowerCase()),
  );
}

export function assertUnauthenticatedProviderConfig(
  provider: Pick<
    GatewayProviderConfig,
    | "kind"
    | "apiKey"
    | "apiKeyHeaderName"
    | "defaultHeaders"
    | "allowUnauthenticated"
  >,
) {
  if (
    provider.allowUnauthenticated !== undefined &&
    typeof provider.allowUnauthenticated !== "boolean"
  ) {
    throw new ModelGatewayError({
      code: "POLICY",
      message: "allowUnauthenticated must be a boolean",
      retryable: false,
    });
  }
  if (!provider.allowUnauthenticated) return;
  const credentialHeader = hasConfiguredCredentialHeaders(provider);
  if (
    provider.kind !== "openai-compatible" ||
    provider.apiKey?.trim() ||
    provider.apiKeyHeaderName?.trim() ||
    credentialHeader
  ) {
    throw new ModelGatewayError({
      code: "POLICY",
      message:
        "Unauthenticated transport requires an openai-compatible Provider without an API key or explicit credential headers",
      retryable: false,
    });
  }
}

export function isUnauthenticatedSystemTarget(target: ResolvedRequestTarget) {
  return (
    target.allowUnauthenticated === true &&
    target.providerKind === "openai-compatible" &&
    target.routeDecision.mode === "GLOBAL" &&
    !target.apiKey?.trim()
  );
}

export function unauthenticatedOpenAIConfiguration(
  target: ResolvedRequestTarget,
) {
  if (!isUnauthenticatedSystemTarget(target)) return {};
  assertUnauthenticatedProviderConfig({ ...target, kind: target.providerKind });
  return {
    allowUnauthenticated: true,
    apiKey: null,
    adminAPIKey: null,
    organization: null,
    project: null,
  };
}

type AuthHeaderInput = Pick<
  ResolvedRequestTarget,
  "apiKey" | "apiKeyHeaderName" | "apiKeyHeaderPrefix" | "defaultHeaders"
>;

export function buildProviderAuthHeaders(
  target: AuthHeaderInput,
): Record<string, string> {
  if (!target.apiKey) {
    return {};
  }
  if (target.apiKeyHeaderName) {
    return {
      [target.apiKeyHeaderName]: `${target.apiKeyHeaderPrefix ?? ""}${target.apiKey}`,
    };
  }
  return {
    Authorization: `Bearer ${target.apiKey}`,
  };
}

export function buildOpenAICompatibleDefaultHeaders(
  target: AuthHeaderInput,
): Record<string, string | null> | undefined {
  if (!target.apiKey || !target.apiKeyHeaderName) {
    return target.defaultHeaders;
  }

  return {
    ...(target.defaultHeaders ?? {}),
    Authorization: null,
    [target.apiKeyHeaderName]: `${target.apiKeyHeaderPrefix ?? ""}${target.apiKey}`,
  };
}
