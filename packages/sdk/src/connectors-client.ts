import type {
  ConnectorWebhookConfigResponse,
  CreateConnectorActionRequest,
  CreateConnectorActionResponse,
  CreateConnectorRequest,
  CreateConnectorResponse,
  DeleteConnectorAccountRequest,
  DeleteConnectorAccountResponse,
  DeleteConnectorRequest,
  DeleteConnectorResponse,
  ExecuteConnectorActionResponse,
  FinishConnectorOAuthResponse,
  ListConnectorActivityRequest,
  ListConnectorActivityResponse,
  ListConnectorActionsResponse,
  ListConnectorManifestsResponse,
  ListConnectorOAuthAccountsRequest,
  ListConnectorOAuthAccountsResponse,
  ListConnectorsRequest,
  ListConnectorWebhookEventsRequest,
  ListConnectorWebhookEventsResponse,
  ListConnectorsResponse,
  ListConnectorSyncRunsResponse,
  ListWorkspaceConnectorSyncRunsRequest,
  ListWorkspaceConnectorSyncRunsResponse,
  StartConnectorOAuthRequest,
  StartConnectorOAuthResponse,
  TriggerConnectorSyncResponse,
  UpdateConnectorResponse,
  UpdateConnectorRequest,
  RespondAgentConfirmationRequest,
  RespondAgentConfirmationResponse,
  ListAgentToolTrustRulesResponse,
  RevokeAgentToolTrustRuleResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

function encode(value: string) {
  return encodeURIComponent(value);
}

function query(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, value);
    }
  }
  return search.size ? `?${search.toString()}` : "";
}

export type GoogleDrivePickerSession = {
  accessToken: string;
  appId: string;
  mimeTypes: string[];
};

// Redeclared rather than imported: the SDK must not depend on the Dropbox
// capability package (packages/builtin-connector-dropbox/src/adapter.ts
// defines the originals). Keep these in sync with that file.
export type DropboxBrowseEntry = {
  id: string;
  kind: "file" | "folder";
  name: string;
  pathDisplay: string;
  size: number | null;
  serverModified: string | null;
  supported: boolean;
};

export type DropboxBrowseFolder = {
  id: string;
  name: string;
  pathDisplay: string;
};

export type DropboxBrowseResult = {
  folder: DropboxBrowseFolder | null;
  breadcrumbs: Array<{ id: string; name: string }>;
  entries: DropboxBrowseEntry[];
  cursor: string;
  hasMore: boolean;
};

export type DropboxSearchResult = {
  entries: DropboxBrowseEntry[];
  cursor: string;
  hasMore: boolean;
};

export type DropboxDescribeItem = {
  id: string;
  kind: "file" | "folder" | null;
  name: string | null;
  pathDisplay: string | null;
  pathLower: string | null;
  exists: boolean;
};

export type DropboxDescribeResult = {
  items: DropboxDescribeItem[];
};

export class ConnectorsClient {
  listGmailLabels(workspaceId: string, connectorId: string) {
    return this.http.get<{
      labels: Array<{ id: string; name: string; type: string }>;
    }>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/gmail/labels`,
    );
  }

  createGoogleDrivePickerSession(workspaceId: string, connectorId: string) {
    return this.http.post<GoogleDrivePickerSession>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/google-drive/picker-session`,
    );
  }

  dropboxBrowse(
    workspaceId: string,
    connectorId: string,
    input: { folderId?: string | null; cursor?: string } = {},
  ) {
    return this.http.post<DropboxBrowseResult>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/dropbox/browse`,
      input,
    );
  }

  dropboxSearch(
    workspaceId: string,
    connectorId: string,
    input: { query: string; cursor?: string },
  ) {
    return this.http.post<DropboxSearchResult>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/dropbox/search`,
      input,
    );
  }

  dropboxDescribe(
    workspaceId: string,
    connectorId: string,
    input: { ids: string[] },
  ) {
    return this.http.post<DropboxDescribeResult>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/dropbox/describe`,
      input,
    );
  }

  constructor(private readonly http: HttpClient) {}

  listManifests(workspaceId: string) {
    return this.http.get<ListConnectorManifestsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/manifests`,
    );
  }

  startOAuth(
    workspaceId: string,
    connectorType: string,
    input: StartConnectorOAuthRequest = {},
  ) {
    return this.http.post<StartConnectorOAuthResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/oauth/${encode(connectorType)}/start`,
      input,
    );
  }

  finishOAuth(
    workspaceId: string,
    connectorType: string,
    input: { code: string; state: string },
  ) {
    return this.http.get<FinishConnectorOAuthResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/oauth/${encode(connectorType)}/callback${query(input)}`,
    );
  }

  listAccounts(
    workspaceId: string,
    input: ListConnectorOAuthAccountsRequest = {},
  ) {
    return this.http.get<ListConnectorOAuthAccountsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/accounts${query({
        connectorType: input.connectorType,
      })}`,
    );
  }

  create(workspaceId: string, input: CreateConnectorRequest) {
    return this.http.post<CreateConnectorResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors`,
      input,
    );
  }

  list(workspaceId: string, input: ListConnectorsRequest = {}) {
    return this.http.get<ListConnectorsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors${query({
        includeDisabled: input.includeDisabled ? "true" : undefined,
      })}`,
    );
  }

  listWorkspaceSyncRuns(
    workspaceId: string,
    input: ListWorkspaceConnectorSyncRunsRequest = {},
  ) {
    return this.http.get<ListWorkspaceConnectorSyncRunsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/sync-runs${query({
        status: input.status,
      })}`,
    );
  }

  update(
    workspaceId: string,
    connectorId: string,
    input: UpdateConnectorRequest,
  ) {
    return this.http.patch<UpdateConnectorResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}`,
      input,
    );
  }

  delete(
    workspaceId: string,
    connectorId: string,
    input: DeleteConnectorRequest = {},
  ) {
    return this.http.delete<DeleteConnectorResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}${query(
        {
          disable: input.disable ? "true" : undefined,
        },
      )}`,
    );
  }

  deleteAccount(
    workspaceId: string,
    accountId: string,
    _input: DeleteConnectorAccountRequest = {},
  ) {
    return this.http.delete<DeleteConnectorAccountResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/accounts/${encode(accountId)}`,
    );
  }

  sync(workspaceId: string, connectorId: string) {
    return this.http.post<TriggerConnectorSyncResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/sync`,
    );
  }

  listSyncRuns(workspaceId: string, connectorId: string) {
    return this.http.get<ListConnectorSyncRunsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/sync-runs`,
    );
  }

  listActivity(
    workspaceId: string,
    connectorId: string,
    input: ListConnectorActivityRequest = {},
  ) {
    return this.http.get<ListConnectorActivityResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/activity${query(
        {
          kind: input.kind,
          limit: input.limit ? String(input.limit) : undefined,
          cursor: input.cursor,
        },
      )}`,
    );
  }

  proposeAction(
    workspaceId: string,
    connectorId: string,
    input: CreateConnectorActionRequest,
  ) {
    return this.http.post<CreateConnectorActionResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions`,
      input,
    );
  }

  approveAction(workspaceId: string, connectorId: string, actionRunId: string) {
    return this.http.post<CreateConnectorActionResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions/${encode(actionRunId)}/approve`,
    );
  }

  rejectAction(workspaceId: string, connectorId: string, actionRunId: string) {
    return this.http.post<CreateConnectorActionResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions/${encode(actionRunId)}/reject`,
    );
  }

  executeAction(workspaceId: string, connectorId: string, actionRunId: string) {
    return this.http.post<ExecuteConnectorActionResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions/${encode(actionRunId)}/execute`,
    );
  }

  respondToConfirmation(
    workspaceId: string,
    confirmationId: string,
    input: RespondAgentConfirmationRequest,
  ) {
    return this.http.post<RespondAgentConfirmationResponse>(
      `/v1/workspaces/${encode(workspaceId)}/agent-confirmations/${encode(confirmationId)}/respond`,
      input,
    );
  }

  /**
   * Standing "always allow" approvals the signed-in user has granted in this
   * workspace. Paired with {@link revokeAgentToolTrustRule}; the two exist so a
   * trust rule is never something the user cannot inspect or take back.
   */
  listAgentToolTrustRules(workspaceId: string) {
    return this.http.get<ListAgentToolTrustRulesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/agent-tool-trust-rules`,
    );
  }

  revokeAgentToolTrustRule(workspaceId: string, trustRuleId: string) {
    return this.http.post<RevokeAgentToolTrustRuleResponse>(
      `/v1/workspaces/${encode(workspaceId)}/agent-tool-trust-rules/${encode(trustRuleId)}/revoke`,
    );
  }

  listActions(workspaceId: string, connectorId: string) {
    return this.http.get<ListConnectorActionsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions`,
    );
  }

  listWebhookEvents(
    workspaceId: string,
    input: ListConnectorWebhookEventsRequest = {},
  ) {
    return this.http.get<ListConnectorWebhookEventsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/webhook-events${query({
        connectorType: input.connectorType,
        connectorId: input.connectorId,
      })}`,
    );
  }

  getWebhookConfig(workspaceId: string, connectorId: string) {
    return this.http.get<ConnectorWebhookConfigResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/webhook-config`,
    );
  }
}
