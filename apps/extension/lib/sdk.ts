import { HttpClient, JobsClient } from "@polyer/sdk";

type ExtensionEnv = {
  VITE_API_BASE_URL?: string;
};

type StoredTokens = {
  accessToken?: string;
};

const env = (import.meta as unknown as { env?: ExtensionEnv }).env;

const apiBaseUrl = env?.VITE_API_BASE_URL || "http://localhost:3001";
const storageKey = "velamind.auth.tokens";

async function readAccessToken() {
  const payload = await chrome.storage.local.get(storageKey);
  const tokens = payload[storageKey] as StoredTokens | undefined;
  return tokens?.accessToken;
}

const httpClient = new HttpClient({
  baseUrl: apiBaseUrl,
  getToken: () => readAccessToken(),
});

export const jobsClient = new JobsClient(httpClient);
