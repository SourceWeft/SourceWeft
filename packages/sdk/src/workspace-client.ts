import type {
  AcceptGuestInvitationRequest,
  AcceptGuestInvitationResponse,
  AddWorkspaceMemberRequest,
  CreateWorkspaceRequest,
  CurrentContextResponse,
  InviteGuestRequest,
  ListTeamAuditLogsResponse,
  ListWorkspaceGuestsResponse,
  ListWorkspaceMembersResponse,
  ListWorkspacesResponse,
  SetWorkspaceContextResponse,
  UpdateWorkspaceMemberRoleRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceMemberMutationResponse,
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

  listWorkspaceMembers(workspaceId: string) {
    return this.http.get<ListWorkspaceMembersResponse>(
      `/v1/workspaces/${encode(workspaceId)}/members`,
    );
  }

  addWorkspaceMember(workspaceId: string, input: AddWorkspaceMemberRequest) {
    return this.http.post<WorkspaceMemberMutationResponse>(
      `/v1/workspaces/${encode(workspaceId)}/members`,
      input,
    );
  }

  updateWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    input: UpdateWorkspaceMemberRoleRequest,
  ) {
    return this.http.patch<WorkspaceMemberMutationResponse>(
      `/v1/workspaces/${encode(workspaceId)}/members/${encode(userId)}`,
      input,
    );
  }

  removeWorkspaceMember(workspaceId: string, userId: string) {
    return this.http.delete<WorkspaceMemberMutationResponse>(
      `/v1/workspaces/${encode(workspaceId)}/members/${encode(userId)}`,
    );
  }

  listTeamAuditLogs(teamId: string, limit?: number) {
    const suffix = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return this.http.get<ListTeamAuditLogsResponse>(
      `/v1/teams/${encode(teamId)}/audit-logs${suffix}`,
    );
  }

  listWorkspaceGuests(workspaceId: string) {
    return this.http.get<ListWorkspaceGuestsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/guests`,
    );
  }

  inviteWorkspaceGuest(workspaceId: string, input: InviteGuestRequest) {
    return this.http.post<{ ok: true }>(
      `/v1/workspaces/${encode(workspaceId)}/guests`,
      input,
    );
  }

  revokeGuestInvitation(workspaceId: string, invitationId: string) {
    return this.http.delete<{ ok: true }>(
      `/v1/workspaces/${encode(workspaceId)}/guests/invitations/${encode(invitationId)}`,
    );
  }

  removeWorkspaceGuest(workspaceId: string, userId: string) {
    return this.http.delete<{ ok: true }>(
      `/v1/workspaces/${encode(workspaceId)}/guests/${encode(userId)}`,
    );
  }

  acceptGuestInvitation(input: AcceptGuestInvitationRequest) {
    return this.http.post<AcceptGuestInvitationResponse>(
      "/v1/guest-invitations/accept",
      input,
    );
  }
}
