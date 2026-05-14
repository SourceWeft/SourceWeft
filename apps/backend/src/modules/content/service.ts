import type { SourceParseJobPayload, SourceParsePollJobPayload } from "./queue";
import type { ContentBillingPort } from "./billing-port";
import type { ChunkSpec } from "./types";
import { contentByokService } from "./byok";
import { contentArtifactsService } from "./artifacts/service";
import { requireContentWorkspace } from "./content-support";
import {
  SourceIndexingService,
  SourceParsingService,
  contentSourceService,
} from "./sources";
import { contentSkillsService } from "./skills";
import {
  ContentThreadStreamService,
  ContentThreadTurnService,
  contentThreadService,
  type EditThreadInput,
  type RefreshThreadInput,
  type StreamThreadEventInput,
  type ThreadToolsSelection,
} from "./threads";
import { durableChatRunService } from "./threads/durable/service";
import type { ChatThreadRunMode } from "./threads/durable/types";
import { workingFilesService } from "./working-files";
import { type LlmExecutionConfig } from "./model-gateway-audit";

export class ContentService {
  private readonly sourceIndexingService: SourceIndexingService;
  private readonly sourceParsingService: SourceParsingService;
  private readonly threadStreamService: ContentThreadStreamService;

  constructor(billing: ContentBillingPort) {
    this.sourceIndexingService = new SourceIndexingService(billing);
    this.sourceParsingService = new SourceParsingService(
      this.sourceIndexingService,
      billing,
    );
    this.threadStreamService = new ContentThreadStreamService(
      new ContentThreadTurnService(billing),
      undefined,
      undefined,
      undefined,
      billing,
    );
  }

  async uploadSource(input: {
    workspaceId: string;
    userId: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
    sizeBytes: number;
    parentSourceId?: string | null;
  }) {
    return contentSourceService.uploadSource(input);
  }

  async createSource(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    sourceType?: Parameters<
      typeof contentSourceService.createSource
    >[0]["sourceType"];
    parentSourceId?: string | null;
    estimatedPages?: number;
    parsedTokens?: number;
  }) {
    return contentSourceService.createSource(input);
  }

  async createUrlSource(input: {
    workspaceId: string;
    userId: string;
    url: string;
    title?: string;
    parentSourceId?: string | null;
    forceRefresh?: boolean;
  }) {
    return contentSourceService.createUrlSource(input);
  }

  async listSources(input: { workspaceId: string; userId: string }) {
    return contentSourceService.listSources(input);
  }

  async listSourceMentions(input: {
    workspaceId: string;
    userId: string;
    query?: string;
    limit?: number;
    cursor?: string;
  }) {
    return contentSourceService.listSourceMentions(input);
  }

  async listSkillsCatalog(input: { workspaceId: string; userId: string }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.listCatalog({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
  }

  async listWorkspaceSkills(input: { workspaceId: string; userId: string }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.listWorkspaceSkills({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
  }

  async getSkillCatalogDetail(input: {
    workspaceId: string;
    userId: string;
    catalogId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.getCatalogSkillDetail({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      catalogId: input.catalogId,
    });
  }

  async enableWorkspaceSkill(input: {
    workspaceId: string;
    userId: string;
    skillId: string;
    skillVersionId: string;
    configJson?: Record<string, unknown>;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.enableSkill({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      configJson: input.configJson,
    });
  }

  async createWorkspaceCustomSkill(input: {
    workspaceId: string;
    userId: string;
    name: string;
    displayName?: string;
    description: string;
    version?: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.createWorkspaceCustomSkill({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      version: input.version,
    });
  }

  async createWorkspaceCustomSkillVersion(input: {
    workspaceId: string;
    userId: string;
    skillId: string;
    version: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.createWorkspaceCustomSkillVersion({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      skillId: input.skillId,
      version: input.version,
    });
  }

  async updateWorkspaceCustomSkillVersion(input: {
    workspaceId: string;
    userId: string;
    skillId: string;
    skillVersionId: string;
    displayName?: string;
    description?: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.updateWorkspaceCustomSkillVersion({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      displayName: input.displayName,
      description: input.description,
    });
  }

  async putWorkspaceCustomSkillVersionFile(input: {
    workspaceId: string;
    userId: string;
    skillId: string;
    skillVersionId: string;
    path: string;
    contentText: string;
    mimeType?: string | null;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.putWorkspaceCustomSkillVersionFile({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      path: input.path,
      contentText: input.contentText,
      mimeType: input.mimeType,
    });
  }

  async deleteWorkspaceCustomSkillVersionFile(input: {
    workspaceId: string;
    userId: string;
    skillId: string;
    skillVersionId: string;
    path: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.deleteWorkspaceCustomSkillVersionFile({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      path: input.path,
    });
  }

  async publishWorkspaceCustomSkillVersion(input: {
    workspaceId: string;
    userId: string;
    skillId: string;
    skillVersionId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.publishWorkspaceCustomSkillVersion({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
    });
  }

  async updateWorkspaceSkill(input: {
    workspaceId: string;
    userId: string;
    workspaceSkillId: string;
    enabled?: boolean;
    configJson?: Record<string, unknown>;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.updateWorkspaceSkill({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      workspaceSkillId: input.workspaceSkillId,
      enabled: input.enabled,
      configJson: input.configJson,
    });
  }

  async deleteWorkspaceSkill(input: {
    workspaceId: string;
    userId: string;
    workspaceSkillId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return contentSkillsService.deleteWorkspaceSkill({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      workspaceSkillId: input.workspaceSkillId,
    });
  }

  async getSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    return contentSourceService.getSource(input);
  }

  async getSourceDocument(input: {
    workspaceId: string;
    sourceId: string;
    documentId: string;
    userId: string;
  }) {
    return contentSourceService.getSourceDocument(input);
  }

  async getSourceStatus(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    return contentSourceService.getSourceStatus(input);
  }

  async getSourceContent(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    return contentSourceService.getSourceContent(input);
  }

  async downloadSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    return contentSourceService.downloadSource(input);
  }

  async updateSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    parentSourceId?: string | null;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
  }) {
    return contentSourceService.updateSource(input);
  }

  async deleteSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    return contentSourceService.deleteSource(input);
  }

  async indexSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: ChunkSpec[];
  }) {
    return this.sourceIndexingService.indexSource(input);
  }

  async reparseSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    chunkSize?: number;
    forceRefresh?: boolean;
  }) {
    return this.sourceParsingService.reparseSource(input);
  }

  async retrySource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    chunkSize?: number;
    forceRefresh?: boolean;
  }) {
    const result = await this.sourceParsingService.tryQueueSourceReparse(input);
    if (result) {
      return {
        ...result,
        mode: "reparse" as const,
      };
    }

    const indexed = await this.sourceIndexingService.indexSource(input);
    return {
      ...indexed,
      mode: "index" as const,
    };
  }

  async processSourceParseJob(
    input: SourceParseJobPayload & { isFinalAttempt?: boolean },
  ) {
    return this.sourceParsingService.processSourceParseJob(input);
  }

  async processSourceParsePollJob(
    input: SourceParsePollJobPayload & { isFinalAttempt?: boolean },
  ) {
    return this.sourceParsingService.processSourceParsePollJob(input);
  }

  async listThreads(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
    cursor?: string;
  }) {
    return contentThreadService.listThreads(input);
  }

  async getThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    return contentThreadService.getThread(input);
  }

  async deleteThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    return contentThreadService.deleteThread(input);
  }

  async updateThreadModelSettings(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  }) {
    return contentThreadService.updateThreadModelSettings(input);
  }

  async listThreadModelCatalog(input: { workspaceId: string; userId: string }) {
    return contentThreadService.listThreadModelCatalog(input);
  }

  async createThread(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    modelSettings?: {
      llmProfileAlias?: string | null;
      imageProfileAlias?: string | null;
      visionProfileAlias?: string | null;
    };
  }) {
    return contentThreadService.createThread(input);
  }

  async getCitationDetail(input: {
    workspaceId: string;
    messageId: string;
    rank: number;
    userId: string;
  }) {
    return contentThreadService.getCitationDetail(input);
  }

  async listThreadMessages(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    return contentThreadService.listThreadMessages(input);
  }

  async getMessageImageFile(input: {
    workspaceId: string;
    messageId: string;
    imageId: string;
    userId: string;
  }) {
    return contentThreadService.getMessageImageFile(input);
  }

  async getArtifactFile(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    return contentArtifactsService.getArtifactFile(input);
  }

  async listArtifacts(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
  }) {
    return contentArtifactsService.listArtifacts(input);
  }

  async listWorkingFiles(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    return workingFilesService.listWorkingFiles(input);
  }

  async getWorkingFile(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
  }) {
    return workingFilesService.getWorkingFile(input);
  }

  async putWorkingFile(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
    contentText: string;
    mimeType?: string | null;
    purpose?: Parameters<
      typeof workingFilesService.putWorkingFile
    >[0]["purpose"];
  }) {
    return workingFilesService.putWorkingFile(input);
  }

  async deleteWorkingFile(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
  }) {
    return workingFilesService.deleteWorkingFile(input);
  }

  async refreshThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    mentionedSourceIds?: string[];
    sourceIds?: string[];
    tools?: ThreadToolsSelection;
    command?: StreamThreadEventInput["command"];
    timezone?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
    image?: LlmExecutionConfig;
    vision?: LlmExecutionConfig;
    visionProfileAlias?: string | null;
  }) {
    return this.threadStreamService.refreshThread(input);
  }

  async *refreshThreadEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    mentionedSourceIds?: string[];
    sourceIds?: string[];
    tools?: ThreadToolsSelection;
    command?: StreamThreadEventInput["command"];
    timezone?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
    image?: LlmExecutionConfig;
    vision?: LlmExecutionConfig;
    visionProfileAlias?: string | null;
  }): AsyncGenerator<string> {
    yield* this.threadStreamService.refreshThreadEvents(input);
  }

  async editThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    imagesProvided?: boolean;
    images?: StreamThreadEventInput["images"];
    mentionedSourceIds?: string[];
    sourceIds?: string[];
    tools?: ThreadToolsSelection;
    command?: StreamThreadEventInput["command"];
    timezone?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
    image?: LlmExecutionConfig;
    vision?: LlmExecutionConfig;
    visionProfileAlias?: string | null;
  }) {
    return this.threadStreamService.editThread(input);
  }

  async *editThreadEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    imagesProvided?: boolean;
    images?: StreamThreadEventInput["images"];
    mentionedSourceIds?: string[];
    sourceIds?: string[];
    tools?: ThreadToolsSelection;
    command?: StreamThreadEventInput["command"];
    timezone?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
    image?: LlmExecutionConfig;
    vision?: LlmExecutionConfig;
    visionProfileAlias?: string | null;
  }): AsyncGenerator<string> {
    yield* this.threadStreamService.editThreadEvents(input);
  }

  async *streamThreadEvents(
    input: StreamThreadEventInput,
  ): AsyncGenerator<string> {
    yield* this.threadStreamService.streamThreadEvents(input);
  }
  async streamThread(input: StreamThreadEventInput) {
    return this.threadStreamService.streamThread(input);
  }

  async getOrCreateDurableThreadRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
    mode: ChatThreadRunMode;
    request: StreamThreadEventInput | RefreshThreadInput | EditThreadInput;
  }) {
    return durableChatRunService.getOrCreateRun(input);
  }

  async stopDurableThreadRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKeyWithStopSuffix: string;
  }) {
    return durableChatRunService.stopRunAndReturn(input);
  }

  async getDurableThreadRunResult(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    return durableChatRunService.getRunResult(input);
  }

  async findDurableThreadRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    return durableChatRunService.findRun(input);
  }

  async findActiveDurableThreadRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    return durableChatRunService.findActiveRun(input);
  }

  async *attachDurableThreadRunEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }): AsyncGenerator<string> {
    yield* durableChatRunService.attachRunEvents(input);
  }
}
