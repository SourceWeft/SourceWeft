export function resolveDeepInfraBaseUrls(baseUrl: string) {
  const rootBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/openai$/i, "");

  return {
    rootBaseUrl,
    openAICompatibleBaseUrl: `${rootBaseUrl}/openai`,
    inferenceBaseUrl: `${rootBaseUrl}/inference`,
  };
}
