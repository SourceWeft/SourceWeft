import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

export type ReviewSubmission = {
  identifier: string;
  name: string;
  summary: string;
  repoUrl: string | null;
  transport: string | null;
  authType: unknown;
  submittedBy: string | null;
  flags: string[];
  createdAt: string;
};

export function listMarketReviewQueue(): Promise<{ items: ReviewSubmission[] }> {
  return http.get("/v1/market/admin/submissions");
}

export function publishMarketSubmission(
  identifier: string,
): Promise<{ identifier: string; status: string }> {
  return http.post(
    `/v1/market/admin/submissions/${encodeURIComponent(identifier)}/publish`,
  );
}

export function rejectMarketSubmission(
  identifier: string,
): Promise<{ identifier: string; status: string }> {
  return http.post(
    `/v1/market/admin/submissions/${encodeURIComponent(identifier)}/reject`,
  );
}
