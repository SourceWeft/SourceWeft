import type { DashboardChatBootstrapResponse } from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

function withQuery(
  path: string,
  input: { includeModelCatalog?: boolean; workspaceId?: string } = {},
) {
  const params = new URLSearchParams();
  if (typeof input.includeModelCatalog === "boolean") {
    params.set("includeModelCatalog", String(input.includeModelCatalog));
  }
  if (input.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export class DashboardClient {
  constructor(private readonly http: HttpClient) {}

  getChatBootstrap(
    input: { includeModelCatalog?: boolean; workspaceId?: string } = {},
  ) {
    return this.http.get<DashboardChatBootstrapResponse>(
      withQuery("/v1/dashboard/chat/bootstrap", input),
    );
  }
}
