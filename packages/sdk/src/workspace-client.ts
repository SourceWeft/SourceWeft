import type {
  CreateWorkspaceRequest,
  CurrentContextResponse,
  ListWorkspacesResponse,
  SetWorkspaceContextResponse,
  UpdateWorkspaceRequest,
  Workspace,
} from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

function encode(value: string) {
  return encodeURIComponent(value);
}

export class WorkspaceClient {
  constructor(private readonly http: HttpClient) {}

  listWorkspaces(teamId: string) {
    return this.http.get<ListWorkspacesResponse>(
      `/v1/teams/${encode(teamId)}/workspaces`,
    );
  }

  createWorkspace(teamId: string, input: CreateWorkspaceRequest) {
    return this.http.post<Workspace>(
      `/v1/teams/${encode(teamId)}/workspaces`,
      input,
    );
  }

  updateWorkspace(workspaceId: string, input: UpdateWorkspaceRequest) {
    return this.http.patch<Workspace>(
      `/v1/workspaces/${encode(workspaceId)}`,
      input,
    );
  }

  getCurrentContext(workspaceId?: string) {
    if (!workspaceId) {
      return this.http.get<CurrentContextResponse>("/v1/context/current");
    }

    return this.http.get<CurrentContextResponse>(
      `/v1/context/current?workspaceId=${encode(workspaceId)}`,
    );
  }

  setWorkspaceContext(workspaceId: string) {
    return this.http.post<SetWorkspaceContextResponse>(
      "/v1/context/workspace",
      {
        workspaceId,
      },
    );
  }
}
