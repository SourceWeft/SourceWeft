import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

export type SubmitMcpResult = {
  identifier: string;
  version: string;
  status: "published" | "reviewing";
  flags: string[];
};

export function submitMcp(repoUrl: string): Promise<SubmitMcpResult> {
  return http.post("/v1/market/submissions", { repoUrl });
}
