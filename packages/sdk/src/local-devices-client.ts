import type {
  ListLocalNetworkRequestsResponse,
  RespondLocalNetworkRequest,
  RespondLocalNetworkRequestResponse,
  UpdateLocalDeviceNetworkMode,
  UpdateLocalDeviceNetworkModeResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

const encode = encodeURIComponent;

/** Outbound-network approvals and policy of the user's local computers. */
export class LocalDevicesClient {
  constructor(private readonly http: HttpClient) {}

  /** Network requests of a local conversation that still await an answer. */
  listNetworkRequests(workspaceId: string, threadId: string) {
    return this.http.get<ListLocalNetworkRequestsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/network-requests`,
    );
  }

  respondNetworkRequest(
    workspaceId: string,
    requestId: string,
    input: RespondLocalNetworkRequest,
  ) {
    return this.http.post<RespondLocalNetworkRequestResponse>(
      `/v1/workspaces/${encode(workspaceId)}/local-network-requests/${encode(requestId)}/respond`,
      input,
    );
  }

  updateNetworkMode(deviceId: string, input: UpdateLocalDeviceNetworkMode) {
    return this.http.patch<UpdateLocalDeviceNetworkModeResponse>(
      `/v1/local-devices/${encode(deviceId)}`,
      input,
    );
  }
}
