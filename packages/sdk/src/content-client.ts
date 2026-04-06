import type {
  CreateSourceRequest,
  CreateSourceResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  DeleteSourceResponse,
  GetSourceResponse,
  IndexSourceRequest,
  IndexSourceResponse,
  ListSourcesResponse,
  ListThreadSourcesResponse,
  SetThreadSourcesRequest,
  SetThreadSourcesResponse,
  StreamThreadRequest,
  StreamThreadResponse,
  UpdateSourceRequest,
  UpdateSourceResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

function encode(value: string) {
  return encodeURIComponent(value);
}

export class ContentClient {
  constructor(private readonly http: HttpClient) {}

  createSource(workspaceId: string, input: CreateSourceRequest) {
    return this.http.post<CreateSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources`,
      input,
    );
  }

  listSources(workspaceId: string) {
    return this.http.get<ListSourcesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources`,
    );
  }

  getSource(workspaceId: string, sourceId: string) {
    return this.http.get<GetSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}`,
    );
  }

  updateSource(
    workspaceId: string,
    sourceId: string,
    input: UpdateSourceRequest,
  ) {
    return this.http.patch<UpdateSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}`,
      input,
    );
  }

  deleteSource(workspaceId: string, sourceId: string) {
    return this.http.delete<DeleteSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}`,
    );
  }

  indexSource(
    workspaceId: string,
    sourceId: string,
    input: IndexSourceRequest = {},
  ) {
    return this.http.post<IndexSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}/index`,
      input,
    );
  }

  createThread(workspaceId: string, input: CreateThreadRequest = {}) {
    return this.http.post<CreateThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads`,
      input,
    );
  }

  listThreadSources(workspaceId: string, threadId: string) {
    return this.http.get<ListThreadSourcesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/sources`,
    );
  }

  setThreadSources(
    workspaceId: string,
    threadId: string,
    input: SetThreadSourcesRequest,
  ) {
    return this.http.put<SetThreadSourcesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/sources`,
      input,
    );
  }

  streamThread(
    workspaceId: string,
    threadId: string,
    input: StreamThreadRequest,
  ) {
    return this.http.post<StreamThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/stream`,
      input,
    );
  }
}
