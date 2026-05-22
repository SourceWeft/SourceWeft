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
  LookupNotionPagesRequest,
  LookupNotionPagesResponse,
  StartConnectorOAuthRequest,
  StartConnectorOAuthResponse,
  TriggerConnectorSyncResponse,
  UpdateConnectorResponse,
  UpdateConnectorRequest,
  RespondAgentConfirmationRequest,
  RespondAgentConfirmationResponse,
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

export class ConnectorsClient {
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

  lookupNotionPages(workspaceId: string, input: LookupNotionPagesRequest = {}) {
    return this.http.get<LookupNotionPagesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/notion/pages${query({
        connectorId: input.connectorId,
        title: input.title,
        fuzzyTitle: input.fuzzyTitle,
        externalId: input.externalId,
        externalUri: input.externalUri,
        limit: input.limit ? String(input.limit) : undefined,
      })}`,
    );
  }
}
