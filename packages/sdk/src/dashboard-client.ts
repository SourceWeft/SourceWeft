import type { DashboardChatBootstrapResponse } from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

function withQuery(path: string, input: { workspaceId?: string } = {}) {
  const params = new URLSearchParams();
  if (input.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export class DashboardClient {
  constructor(private readonly http: HttpClient) {}

  getChatBootstrap(input: { workspaceId?: string } = {}) {
    return this.http.get<DashboardChatBootstrapResponse>(
      withQuery("/v1/dashboard/chat/bootstrap", input),
    );
  }
}
