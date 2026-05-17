import type {
  AddByokModelRequest,
  AddByokModelResponse,
  CitationDetailResponse,
  CreateByokCredentialRequest,
  CreateByokCredentialResponse,
  CreateSourceRequest,
  CreateSourceResponse,
  CreateUrlSourceRequest,
  CreateUrlSourceResponse,
  EditThreadRequest,
  EditThreadResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  CreateCustomSkillRequest,
  CreateCustomSkillVersionRequest,
  CustomSkillResponse,
  DeleteByokCredentialResponse,
  DeleteByokModelResponse,
  DeleteCustomSkillVersionFileResponse,
  DeleteSourceResponse,
  DeleteThreadResponse,
  DeleteWorkingFileResponse,
  DeleteWorkspaceSkillResponse,
  EnableWorkspaceSkillRequest,
  EnableWorkspaceSkillResponse,
  GetThreadResponse,
  RefreshThreadRequest,
  RefreshThreadResponse,
  GetSourceDocumentResponse,
  GetSourceResponse,
  GetSkillCatalogDetailResponse,
  IndexSourceRequest,
  IndexSourceResponse,
  GetWorkingFileResponse,
  ListArtifactsResponse,
  ListThreadModelCatalogResponse,
  ListByokProvidersResponse,
  ListByokCredentialsResponse,
  ListByokModelsResponse,
  ListSourceMentionsRequest,
  ListSourceMentionsResponse,
  ListSkillsCatalogResponse,
  ListThreadsRequest,
  ListSourcesResponse,
  ListWorkspaceSkillsResponse,
  ListWorkingFilesResponse,
  PutCustomSkillVersionFileRequest,
  PutCustomSkillVersionFileResponse,
  PutWorkingFileRequest,
  PutWorkingFileResponse,
  ReparseSourceRequest,
  ReparseSourceResponse,
  ResolveByokModelCapabilitiesRequest,
  ResolveByokModelCapabilitiesResponse,
  RetrySourceRequest,
  RetrySourceResponse,
  SourceStatusResponse,
  ListThreadsResponse,
  StartThreadTurnRequest,
  StartThreadTurnResponse,
  StreamThreadRequest,
  StreamThreadResponse,
  UploadSourceResponse,
  UpdateThreadModelSettingsRequest,
  UpdateThreadModelSettingsResponse,
  UpdateCustomSkillVersionRequest,
  ListThreadMessagesResponse,
  UpdateSourceRequest,
  UpdateSourceResponse,
  UpdateWorkspaceSkillRequest,
  UpdateWorkspaceSkillResponse,
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

  createUrlSource(workspaceId: string, input: CreateUrlSourceRequest) {
    return this.http.post<CreateUrlSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/url`,
      input,
    );
  }

  listSources(workspaceId: string) {
    return this.http.get<ListSourcesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources`,
    );
  }

  listArtifacts(workspaceId: string, input: { limit?: number } = {}) {
    const params = new URLSearchParams();
    if (input.limit) {
      params.set("limit", String(input.limit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";

    return this.http.get<ListArtifactsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts${suffix}`,
    );
  }

  listSourceMentions(
    workspaceId: string,
    input: ListSourceMentionsRequest = {},
  ) {
    const params = new URLSearchParams();
    if (input.query) {
      params.set("query", input.query);
    }
    if (input.limit) {
      params.set("limit", String(input.limit));
    }
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";

    return this.http.get<ListSourceMentionsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/mentions${suffix}`,
    );
  }

  uploadSource(
    workspaceId: string,
    file: File,
    input: { parentSourceId?: string | null } = {},
  ) {
    const formData = new FormData();
    formData.append("file", file);
    if (input.parentSourceId) {
      formData.append("parentSourceId", input.parentSourceId);
    }

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

  getSourceDocument(workspaceId: string, sourceId: string, documentId: string) {
    return this.http.get<GetSourceDocumentResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}/documents/${encode(documentId)}`,
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

  reparseSource(
    workspaceId: string,
    sourceId: string,
    input: ReparseSourceRequest = {},
  ) {
    return this.http.post<ReparseSourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}/reparse`,
      input,
    );
  }

  retrySource(
    workspaceId: string,
    sourceId: string,
    input: RetrySourceRequest = {},
  ) {
    return this.http.post<RetrySourceResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}/retry`,
      input,
    );
  }

  createThread(workspaceId: string, input: CreateThreadRequest = {}) {
    return this.http.post<CreateThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads`,
      input,
    );
  }

  startThreadTurn(workspaceId: string, input: StartThreadTurnRequest) {
    return this.http.post<StartThreadTurnResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/start-turn`,
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

  getActiveThreadRun(workspaceId: string, threadId: string) {
    return this.http.get<{
      threadRun: {
        id: string;
        idempotencyKey: string;
        status: "queued" | "running" | "cancel_requested";
        mode: "send" | "refresh" | "edit";
        userMessageId: string | null;
        assistantMessageId: string | null;
      } | null;
    }>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/active-run`,
    );
  }

  listWorkingFiles(workspaceId: string, threadId: string) {
    return this.http.get<ListWorkingFilesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/working-files`,
    );
  }

  getWorkingFile(workspaceId: string, threadId: string, path: string) {
    return this.http.get<GetWorkingFileResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/working-files/content?path=${encode(path)}`,
    );
  }

  putWorkingFile(
    workspaceId: string,
    threadId: string,
    path: string,
    input: PutWorkingFileRequest,
  ) {
    return this.http.put<PutWorkingFileResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/working-files/content?path=${encode(path)}`,
      input,
    );
  }

  deleteWorkingFile(workspaceId: string, threadId: string, path: string) {
    return this.http.delete<DeleteWorkingFileResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/working-files?path=${encode(path)}`,
    );
  }

  getThread(workspaceId: string, threadId: string) {
    return this.http.get<GetThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}`,
    );
  }

  deleteThread(workspaceId: string, threadId: string) {
    return this.http.delete<DeleteThreadResponse>(
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

  listByokProviders(workspaceId: string) {
    return this.http.get<ListByokProvidersResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-providers`,
    );
  }

  listSkillsCatalog(workspaceId: string) {
    return this.http.get<ListSkillsCatalogResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/catalog`,
    );
  }

  listWorkspaceSkills(workspaceId: string) {
    return this.http.get<ListWorkspaceSkillsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills`,
    );
  }

  getSkillCatalogDetail(workspaceId: string, catalogId: string) {
    return this.http.get<GetSkillCatalogDetailResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/catalog/${encode(catalogId)}`,
    );
  }

  enableWorkspaceSkill(workspaceId: string, input: EnableWorkspaceSkillRequest) {
    return this.http.post<EnableWorkspaceSkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills`,
      input,
    );
  }

  updateWorkspaceSkill(
    workspaceId: string,
    workspaceSkillId: string,
    input: UpdateWorkspaceSkillRequest,
  ) {
    return this.http.patch<UpdateWorkspaceSkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/${encode(workspaceSkillId)}`,
      input,
    );
  }

  deleteWorkspaceSkill(workspaceId: string, workspaceSkillId: string) {
    return this.http.delete<DeleteWorkspaceSkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/${encode(workspaceSkillId)}`,
    );
  }

  createCustomSkill(workspaceId: string, input: CreateCustomSkillRequest) {
    return this.http.post<CustomSkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/custom`,
      input,
    );
  }

  createCustomSkillVersion(
    workspaceId: string,
    skillId: string,
    input: CreateCustomSkillVersionRequest,
  ) {
    return this.http.post<CustomSkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/custom/${encode(skillId)}/versions`,
      input,
    );
  }

  updateCustomSkillVersion(
    workspaceId: string,
    skillId: string,
    versionId: string,
    input: UpdateCustomSkillVersionRequest,
  ) {
    return this.http.patch<CustomSkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/custom/${encode(skillId)}/versions/${encode(versionId)}`,
      input,
    );
  }

  putCustomSkillVersionFile(
    workspaceId: string,
    skillId: string,
    versionId: string,
    path: string,
    input: PutCustomSkillVersionFileRequest,
  ) {
    return this.http.put<PutCustomSkillVersionFileResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/custom/${encode(skillId)}/versions/${encode(versionId)}/files/${path.split("/").map(encode).join("/")}`,
      input,
    );
  }

  deleteCustomSkillVersionFile(
    workspaceId: string,
    skillId: string,
    versionId: string,
    path: string,
  ) {
    return this.http.delete<DeleteCustomSkillVersionFileResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/custom/${encode(skillId)}/versions/${encode(versionId)}/files/${path.split("/").map(encode).join("/")}`,
    );
  }

  publishCustomSkillVersion(
    workspaceId: string,
    skillId: string,
    versionId: string,
  ) {
    return this.http.post<CustomSkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/custom/${encode(skillId)}/versions/${encode(versionId)}/publish`,
      {},
    );
  }

  listByokCredentials(workspaceId: string) {
    return this.http.get<ListByokCredentialsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-credentials`,
    );
  }

  createByokCredential(
    workspaceId: string,
    input: CreateByokCredentialRequest,
  ) {
    return this.http.post<CreateByokCredentialResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-credentials`,
      input,
    );
  }

  deleteByokCredential(workspaceId: string, credentialId: string) {
    return this.http.delete<DeleteByokCredentialResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-credentials/${encode(credentialId)}`,
    );
  }

  resolveByokModelCapabilities(
    workspaceId: string,
    input: ResolveByokModelCapabilitiesRequest,
  ) {
    return this.http.post<ResolveByokModelCapabilitiesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-model-capabilities`,
      input,
    );
  }

  addByokModel(workspaceId: string, input: AddByokModelRequest) {
    return this.http.post<AddByokModelResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-models`,
      input,
    );
  }

  listByokModels(workspaceId: string, input: { credentialId?: string } = {}) {
    const params = new URLSearchParams();
    if (input.credentialId) {
      params.set("credentialId", input.credentialId);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.http.get<ListByokModelsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-models${suffix}`,
    );
  }

  deleteByokModel(workspaceId: string, modelId: string) {
    return this.http.delete<DeleteByokModelResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-models/${encode(modelId)}`,
    );
  }

  getCitationDetail(workspaceId: string, messageId: string, rank: number) {
    return this.http.get<CitationDetailResponse>(
      `/v1/workspaces/${encode(workspaceId)}/messages/${encode(messageId)}/citations/${encode(String(rank))}`,
    );
  }

  streamThread(
    workspaceId: string,
    threadId: string,
    input: StreamThreadRequest,
  ) {
    return this.http.post<StreamThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/stream`,
      {
        ...input,
        stream: false,
      },
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
        stream: false,
      },
    );
  }

  editThread(workspaceId: string, threadId: string, input: EditThreadRequest) {
    return this.http.post<EditThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/stream`,
      {
        ...input,
        mode: "edit",
        stream: false,
      },
    );
  }
}
