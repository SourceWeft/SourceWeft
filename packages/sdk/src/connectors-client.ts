import type {
  CreateConnectorActionRequest,
  CreateConnectorActionResponse,
  CreateConnectorRequest,
  CreateConnectorResponse,
  DeleteConnectorResponse,
  ExecuteConnectorActionResponse,
  FinishConnectorOAuthResponse,
  ListConnectorActionsResponse,
  ListConnectorManifestsResponse,
  ListConnectorOAuthAccountsRequest,
  ListConnectorOAuthAccountsResponse,
  ListConnectorsResponse,
  ListConnectorSyncRunsResponse,
  StartConnectorOAuthRequest,
  StartConnectorOAuthResponse,
  TriggerConnectorSyncResponse,
  UpdateConnectorResponse,
  UpdateConnectorRequest,
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

  list(workspaceId: string) {
    return this.http.get<ListConnectorsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors`,
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

  delete(workspaceId: string, connectorId: string) {
    return this.http.delete<DeleteConnectorResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}`,
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

  approveAction(
    workspaceId: string,
    connectorId: string,
    actionRunId: string,
  ) {
    return this.http.post<CreateConnectorActionResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions/${encode(actionRunId)}/approve`,
    );
  }

  rejectAction(
    workspaceId: string,
    connectorId: string,
    actionRunId: string,
  ) {
    return this.http.post<CreateConnectorActionResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions/${encode(actionRunId)}/reject`,
    );
  }

  executeAction(
    workspaceId: string,
    connectorId: string,
    actionRunId: string,
  ) {
    return this.http.post<ExecuteConnectorActionResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions/${encode(actionRunId)}/execute`,
    );
  }

  listActions(workspaceId: string, connectorId: string) {
    return this.http.get<ListConnectorActionsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/connectors/${encode(connectorId)}/actions`,
    );
  }
}
