import { HttpClient, JobsClient } from "@polyer/sdk";

type DesktopEnv = {
  VITE_API_BASE_URL?: string;
};

const env = (import.meta as unknown as { env?: DesktopEnv }).env;

const apiBaseUrl = env?.VITE_API_BASE_URL || "http://localhost:3001";

const httpClient = new HttpClient({
  baseUrl: apiBaseUrl,
});

export const jobsClient = new JobsClient(httpClient);
