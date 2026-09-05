import type {
  AddByokModelRequest,
  AddByokModelResponse,
  BulkDeleteSourcesRequest,
  BulkDeleteSourcesResponse,
  CreateArtifactShareRequest,
  UpdateArtifactShareRequest,
  ShareResponse,
  GetShareResponse,
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
  DeleteArtifactResponse,
  DeleteByokCredentialResponse,
  DeleteByokModelResponse,
  DeleteCustomSkillVersionFileResponse,
  DeleteWorkspaceMcpInstallResponse,
  DeleteSourceResponse,
  DeleteThreadResponse,
  DeleteWorkingFileResponse,
  DeleteWorkspaceSkillResponse,
  EnableWorkspaceSkillRequest,
  EnableWorkspaceSkillResponse,
  GetThreadResponse,
  RefreshThreadRequest,
  RefreshThreadResponse,
  ResumeThreadRequest,
  ResumeThreadResponse,
  GetSourceDocumentResponse,
  GetSourceResponse,
  GetArtifactResponse,
  GetArtifactVersionMediaResponse,
  GetSkillCatalogDetailResponse,
  IndexSourceRequest,
  IndexSourceResponse,
  GetWorkingFileResponse,
  GetWorkspaceMarketMcpResponse,
  InstallMarketMcpRequest,
  InstallMarketMcpResponse,
  ListCapabilityCatalogResponse,
  ListArtifactSummariesResponse,
  ListArtifactsResponse,
  ListThreadModelCatalogResponse,
  ListThreadModelSelectorCatalogResponse,
  ListByokProvidersResponse,
  ListByokModelCandidatesResponse,
  ListByokCredentialsResponse,
  ListWorkspaceMarketMcpCategoriesResponse,
  ListWorkspaceMarketMcpCategoryCountsResponse,
  ListWorkspaceMarketMcpResponse,
  ListWorkspaceMcpActionRunsResponse,
  ListWorkspaceMcpInstallsResponse,
  ListWorkspaceMcpRunsResponse,
  ListByokModelsResponse,
  ListSourceMentionsRequest,
  ListSourceMentionsResponse,
  ListSourcesRequest,
  ListSourceStatusesRequest,
  ListSourceStatusesResponse,
  ListSkillsCatalogResponse,
  SearchRegistrySkillsResponse,
  SubmitRegistrySkillRequest,
  SubmitRegistrySkillResponse,
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
  CompleteSourceUploadResponse,
  CreateSourceUploadIntentRequest,
  CreateSourceUploadIntentResponse,
  UploadSourceResponse,
  UpdateWorkspaceMcpInstallRequest,
  UpdateWorkspaceMcpInstallResponse,
  ThreadChatPreferencesBootstrapResponse,
  UpdateThreadChatPreferencesRequest,
  UpdateThreadChatPreferencesResponse,
  UpdateThreadModelSettingsRequest,
  UpdateThreadModelSettingsResponse,
  UpdateThreadVisibilityRequest,
  UpdateThreadVisibilityResponse,
  UpdateCustomSkillVersionRequest,
  ListThreadMessagesResponse,
  ListThreadMessagesRequest,
  UpdateSourceRequest,
  UpdateSourceResponse,
  UpsertWorkspaceMcpCredentialsRequest,
  UpsertWorkspaceMcpCredentialsResponse,
  TestWorkspaceMcpInstallResponse,
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

  listSources(workspaceId: string, input: ListSourcesRequest = {}) {
    const params = new URLSearchParams();
    if (input.view) {
      params.set("view", input.view);
    }
    if (typeof input.includeContent === "boolean") {
      params.set("includeContent", String(input.includeContent));
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    if (input.parentSourceId !== undefined) {
      params.set("parentSourceId", input.parentSourceId ?? "__root");
    }
    if (input.connectorId) {
      params.set("connectorId", input.connectorId);
    }
    if (input.syncRunId) {
      params.set("syncRunId", input.syncRunId);
    }
    if (input.updatedAfter) {
      params.set("updatedAfter", input.updatedAfter);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";

    return this.http.get<ListSourcesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources${suffix}`,
    );
  }

  listArtifacts(
    workspaceId: string,
    input: { cursor?: string; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (input.limit) {
      params.set("limit", String(input.limit));
    }
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";

    return this.http.get<ListArtifactsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts${suffix}`,
    );
  }

  listArtifactSummaries(
    workspaceId: string,
    input: { cursor?: string; limit?: number } = {},
  ) {
    const params = new URLSearchParams({ view: "summary" });
    if (input.limit) {
      params.set("limit", String(input.limit));
    }
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }

    return this.http.get<ListArtifactSummariesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts?${params.toString()}`,
    );
  }

  getArtifactShare(workspaceId: string, artifactId: string) {
    return this.http.get<GetShareResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts/${encode(artifactId)}/share`,
    );
  }

  shareArtifact(
    workspaceId: string,
    artifactId: string,
    input: CreateArtifactShareRequest = {},
  ) {
    return this.http.post<ShareResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts/${encode(artifactId)}/share`,
      input,
    );
  }

  updateArtifactShare(
    workspaceId: string,
    artifactId: string,
    input: UpdateArtifactShareRequest,
  ) {
    return this.http.patch<ShareResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts/${encode(artifactId)}/share`,
      input,
    );
  }

  revokeArtifactShare(workspaceId: string, artifactId: string) {
    return this.http.delete<{ ok: true }>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts/${encode(artifactId)}/share`,
    );
  }

  getArtifact(workspaceId: string, artifactId: string) {
    return this.http.get<GetArtifactResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts/${encode(artifactId)}`,
    );
  }

  getArtifactVersionMedia(
    workspaceId: string,
    artifactId: string,
    artifactVersionId: string,
  ) {
    return this.http.get<GetArtifactVersionMediaResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts/${encode(artifactId)}/versions/${encode(artifactVersionId)}/media`,
    );
  }

  deleteArtifact(workspaceId: string, artifactId: string) {
    return this.http.delete<DeleteArtifactResponse>(
      `/v1/workspaces/${encode(workspaceId)}/artifacts/${encode(artifactId)}`,
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

  /**
   * Uploads a file in one request. This is the upload method for API and SDK
   * integrations, and the only one they need.
   *
   * One call, no negotiation: an integration never asks the deployment how it
   * is configured before sending a file. `uploadSourceFromBrowser` exists
   * alongside it for our own web client, which can be handed a presigned target
   * the browser writes to directly — that is a first-party optimization, not a
   * better version of this method.
   */
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

  createSourceUploadIntent(
    workspaceId: string,
    input: CreateSourceUploadIntentRequest,
  ) {
    return this.http.post<CreateSourceUploadIntentResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/upload-intent`,
      input,
    );
  }

  completeSourceUpload(workspaceId: string, sourceId: string) {
    return this.http.post<CompleteSourceUploadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/${encode(sourceId)}/upload-complete`,
      {},
    );
  }

  /**
   * The web client's upload path. Not for API integrations — they call
   * `uploadSource`, which sends the file in a single request.
   *
   * Only a browser needs this: it is the one caller that benefits from keeping
   * a large file off the API process and out of a cross-continent round trip,
   * and the only one for which the deployment's answer can differ. Which path
   * runs is read from the server at call time rather than baked into the
   * client, because a self-hosted install whose bucket has no CORS policy must
   * keep working without rebuilding the frontend: it answers `proxy` and this
   * falls through to `uploadSource`.
   *
   * Both paths return the same shape, so nothing downstream branches on which
   * one ran. When the direct PUT fails the error surfaces as-is: the reserved
   * source row is left to the server's sweep rather than cleaned up from here,
   * because a client that just failed to upload is the one least able to
   * guarantee a follow-up request lands.
   */
  async uploadSourceFromBrowser(
    workspaceId: string,
    file: File,
    input: { parentSourceId?: string | null; signal?: AbortSignal } = {},
  ): Promise<CompleteSourceUploadResponse> {
    const intent = await this.createSourceUploadIntent(workspaceId, {
      fileName: file.name || "upload.bin",
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      parentSourceId: input.parentSourceId ?? null,
    });

    // The deployment, not the caller, decides which path is available. A server
    // that has not been given a CORS-configured bucket answers `proxy`, and the
    // file goes through the API instead — same return shape either way, so the
    // caller never branches on it.
    if (intent.mode === "proxy") {
      return this.uploadSource(workspaceId, file, {
        parentSourceId: input.parentSourceId ?? null,
      });
    }

    const response = await fetch(intent.uploadUrl, {
      method: "PUT",
      // Must match what the server signed, or the store rejects the write.
      headers: { "Content-Type": intent.contentType },
      body: file,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `Upload failed with ${response.status} ${response.statusText}`,
      );
    }

    return this.completeSourceUpload(workspaceId, intent.sourceId);
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

  listSourceStatuses(workspaceId: string, input: ListSourceStatusesRequest) {
    return this.http.post<ListSourceStatusesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/status`,
      input,
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

  bulkDeleteSources(workspaceId: string, input: BulkDeleteSourcesRequest) {
    return this.http.post<BulkDeleteSourcesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/sources/bulk-delete`,
      input,
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

  listThreadMessages(
    workspaceId: string,
    threadId: string,
    input: ListThreadMessagesRequest = {},
  ) {
    const params = new URLSearchParams();
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    if (input.after) {
      params.set("after", input.after);
    }
    if (input.include) {
      params.set("include", input.include);
    }

    const query = params.toString();
    return this.http.get<ListThreadMessagesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/messages${query ? `?${query}` : ""}`,
    );
  }

  getActiveThreadRun(workspaceId: string, threadId: string) {
    return this.http.get<{
      threadRun: {
        id: string;
        idempotencyKey: string;
        status:
          "queued" | "running" | "cancel_requested" | "waiting_for_approval";
        mode: "send" | "refresh" | "edit" | "resume";
        userId: string;
        userMessageId: string | null;
        assistantMessageId: string | null;
        approvalRequestedAt?: string | null;
        approvalExpiresAt?: string | null;
      } | null;
    }>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/active-run`,
    );
  }

  sendThreadTyping(workspaceId: string, threadId: string, typing: boolean) {
    return this.http.post<{ ok: true }>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/typing`,
      { typing },
    );
  }

  resolveThreadPresenceIdentities(
    workspaceId: string,
    threadId: string,
    userIds: string[],
  ) {
    return this.http.post<{
      identities: {
        userId: string;
        name: string | null;
        image: string | null;
        isGuest: boolean;
      }[];
    }>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/presence/identities`,
      { userIds },
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

  updateThreadChatPreferences(
    workspaceId: string,
    threadId: string,
    input: UpdateThreadChatPreferencesRequest,
  ) {
    return this.http.patch<UpdateThreadChatPreferencesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/chat-preferences`,
      input,
    );
  }

  updateThreadVisibility(
    workspaceId: string,
    threadId: string,
    input: UpdateThreadVisibilityRequest,
  ) {
    return this.http.patch<UpdateThreadVisibilityResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/visibility`,
      input,
    );
  }

  getInitialChatPreferences(workspaceId: string) {
    return this.http.get<ThreadChatPreferencesBootstrapResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/chat-preferences/bootstrap`,
    );
  }

  listThreadModelCatalog(workspaceId: string) {
    return this.http.get<ListThreadModelCatalogResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/models`,
    );
  }

  listThreadModelSelectorCatalog(workspaceId: string) {
    return this.http.get<ListThreadModelSelectorCatalogResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/models?view=selector`,
    );
  }

  listCapabilityCatalog(workspaceId: string) {
    return this.http.get<ListCapabilityCatalogResponse>(
      `/v1/workspaces/${encode(workspaceId)}/capabilities/catalog`,
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

  searchSkillRegistry(workspaceId: string, query: string) {
    return this.http.get<SearchRegistrySkillsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/registry/search?q=${encodeURIComponent(query)}`,
    );
  }

  submitRegistrySkill(workspaceId: string, input: SubmitRegistrySkillRequest) {
    return this.http.post<SubmitRegistrySkillResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/registry/submit`,
      input,
    );
  }

  getSkillCatalogDetail(workspaceId: string, catalogId: string) {
    return this.http.get<GetSkillCatalogDetailResponse>(
      `/v1/workspaces/${encode(workspaceId)}/skills/catalog/${encode(catalogId)}`,
    );
  }

  enableWorkspaceSkill(
    workspaceId: string,
    input: EnableWorkspaceSkillRequest,
  ) {
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

  listWorkspaceMarketMcp(
    workspaceId: string,
    params?: {
      query?: string;
      category?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    const search = new URLSearchParams();
    if (params?.query) search.set("query", params.query);
    if (params?.category) search.set("category", params.category);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.http.get<ListWorkspaceMarketMcpResponse>(
      `/v1/workspaces/${encode(workspaceId)}/market/mcp${suffix}`,
    );
  }

  listWorkspaceMarketMcpCategories(workspaceId: string) {
    return this.http.get<ListWorkspaceMarketMcpCategoriesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/market/mcp/categories`,
    );
  }

  getWorkspaceMarketMcpCategoryCounts(
    workspaceId: string,
    params?: { query?: string },
  ) {
    const search = new URLSearchParams();
    if (params?.query) search.set("query", params.query);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.http.get<ListWorkspaceMarketMcpCategoryCountsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/market/mcp/category-counts${suffix}`,
    );
  }

  getWorkspaceMarketMcp(workspaceId: string, identifier: string) {
    return this.http.get<GetWorkspaceMarketMcpResponse>(
      `/v1/workspaces/${encode(workspaceId)}/market/mcp/${encode(identifier)}`,
    );
  }

  installMarketMcp(
    workspaceId: string,
    identifier: string,
    input: InstallMarketMcpRequest = {},
  ) {
    return this.http.post<InstallMarketMcpResponse>(
      `/v1/workspaces/${encode(workspaceId)}/market/mcp/${encode(identifier)}/install`,
      input,
    );
  }

  listWorkspaceMcpInstalls(workspaceId: string) {
    return this.http.get<ListWorkspaceMcpInstallsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/mcp-installs`,
    );
  }

  listWorkspaceMcpRuns(
    workspaceId: string,
    input: { cursor?: string | null; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.http.get<ListWorkspaceMcpRunsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/mcp-runs${suffix}`,
    );
  }

  listWorkspaceMcpActionRuns(
    workspaceId: string,
    input: { cursor?: string | null; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.http.get<ListWorkspaceMcpActionRunsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/mcp-action-runs${suffix}`,
    );
  }

  updateWorkspaceMcpInstall(
    workspaceId: string,
    installId: string,
    input: UpdateWorkspaceMcpInstallRequest,
  ) {
    return this.http.patch<UpdateWorkspaceMcpInstallResponse>(
      `/v1/workspaces/${encode(workspaceId)}/mcp-installs/${encode(installId)}`,
      input,
    );
  }

  deleteWorkspaceMcpInstall(workspaceId: string, installId: string) {
    return this.http.delete<DeleteWorkspaceMcpInstallResponse>(
      `/v1/workspaces/${encode(workspaceId)}/mcp-installs/${encode(installId)}`,
    );
  }

  upsertWorkspaceMcpCredentials(
    workspaceId: string,
    installId: string,
    input: UpsertWorkspaceMcpCredentialsRequest,
  ) {
    return this.http.post<UpsertWorkspaceMcpCredentialsResponse>(
      `/v1/workspaces/${encode(workspaceId)}/mcp-installs/${encode(installId)}/credentials`,
      input,
    );
  }

  testWorkspaceMcpInstall(workspaceId: string, installId: string) {
    return this.http.post<TestWorkspaceMcpInstallResponse>(
      `/v1/workspaces/${encode(workspaceId)}/mcp-installs/${encode(installId)}/test`,
      {},
    );
  }

  authorizeWorkspaceMcpOAuth(workspaceId: string, installId: string) {
    return this.http.post<
      { status: "redirect"; authorizationUrl: string } | { status: "connected" }
    >(
      `/v1/workspaces/${encode(workspaceId)}/mcp-installs/${encode(installId)}/oauth/authorize`,
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

  listByokModelCandidates(workspaceId: string, credentialId: string) {
    return this.http.get<ListByokModelCandidatesResponse>(
      `/v1/workspaces/${encode(workspaceId)}/model-gateway/byok-credentials/${encode(credentialId)}/models`,
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

  resumeThread(
    workspaceId: string,
    threadId: string,
    input: ResumeThreadRequest,
  ) {
    return this.http.post<ResumeThreadResponse>(
      `/v1/workspaces/${encode(workspaceId)}/threads/${encode(threadId)}/stream`,
      {
        ...input,
        mode: "resume",
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
