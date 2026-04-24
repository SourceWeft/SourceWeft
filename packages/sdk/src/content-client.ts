import type {
  CreateSourceRequest,
  CreateSourceResponse,
  EditThreadRequest,
  EditThreadResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  DeleteSourceResponse,
  GetThreadResponse,
  RefreshThreadRequest,
  RefreshThreadResponse,
  GetSourceResponse,
  IndexSourceRequest,
  IndexSourceResponse,
  ListThreadModelCatalogResponse,
  ListThreadsRequest,
  ListSourcesResponse,
  SourceStatusResponse,
  ListThreadsResponse,
  StreamThreadRequest,
  StreamThreadResponse,
  UploadSourceResponse,
  UpdateThreadModelSettingsRequest,
  UpdateThreadModelSettingsResponse,
  ListThreadMessagesResponse,
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

  uploadSource(workspaceId: string, file: File) {
    const formData = new FormData();
    formData.append("file", file);

    return this.http.postForm<UploadSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/upload`,
      formData,
    );
  }

  getSource(workspaceId: string, sourceId: string) {
    return this.http.get<GetSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}`,
    );
  }

  getSourceStatus(workspaceId: string, sourceId: string) {
    return this.http.get<SourceStatusResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}/status`,
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

  listThreads(workspaceId: string, input: ListThreadsRequest = {}) {
    const params = new URLSearchParams();
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }

    const query = params.toString();
    return this.http.get<ListThreadsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads${query ? `?${query}` : ""}`,
    );
  }

  listThreadMessages(workspaceId: string, threadId: string) {
    return this.http.get<ListThreadMessagesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/messages`,
    );
  }

  getThread(workspaceId: string, threadId: string) {
    return this.http.get<GetThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}`,
    );
  }

  updateThreadModelSettings(
    workspaceId: string,
    threadId: string,
    input: UpdateThreadModelSettingsRequest,
  ) {
    return this.http.patch<UpdateThreadModelSettingsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/model-settings`,
      input,
    );
  }

  listThreadModelCatalog(workspaceId: string) {
    return this.http.get<ListThreadModelCatalogResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/models`,
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

  refreshThread(
    workspaceId: string,
    threadId: string,
    input: RefreshThreadRequest = {},
  ) {
    return this.http.post<RefreshThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/stream`,
      {
        ...input,
        mode: "refresh",
      },
    );
  }

  editThread(
    workspaceId: string,
    threadId: string,
    input: EditThreadRequest,
  ) {
    return this.http.post<EditThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/stream`,
      {
        ...input,
        mode: "edit",
      },
    );
  }
}
