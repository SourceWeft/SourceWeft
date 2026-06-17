import { createSourceweftClient } from "@sourceweft/sdk";

type DesktopEnv = {
  VITE_API_BASE_URL?: string;
};

const env = (import.meta as unknown as { env?: DesktopEnv }).env;

const apiBaseUrl = env?.VITE_API_BASE_URL || "http://localhost:3001";

export const client = createSourceweftClient(apiBaseUrl);

// Backward-compatible named exports
export const { jobs: jobsClient } = client;
