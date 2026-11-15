import type { AdminOverviewResponse } from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

/** What is waiting for an admin, as numbers. 403 to anyone who is not one. */
export function getAdminOverview() {
  return http.get<AdminOverviewResponse>("/v1/admin/overview");
}
