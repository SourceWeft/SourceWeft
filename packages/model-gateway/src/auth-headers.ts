import type { ResolvedRequestTarget } from "./types";

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
      [target.apiKeyHeaderName]:
        `${target.apiKeyHeaderPrefix ?? ""}${target.apiKey}`,
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
    [target.apiKeyHeaderName]:
      `${target.apiKeyHeaderPrefix ?? ""}${target.apiKey}`,
  };
}
