import type { SourceParseJobPayload, SourceParsePollJobPayload } from "./queue";
import type { ContentBillingPort } from "./billing-port";
import type { ChunkSpec } from "./types";
import { contentByokService } from "./byok";
import {
  SourceIndexingService,
  SourceParsingService,
  contentSourceService,
} from "./sources";
import {
  ContentThreadStreamService,
  ContentThreadTurnService,
  contentThreadService,
  type StreamThreadEventInput,
} from "./threads";
import { type LlmExecutionConfig } from "./model-gateway-audit";

export class ContentService {
  private readonly sourceIndexingService: SourceIndexingService;
  private readonly sourceParsingService: SourceParsingService;
  private readonly threadStreamService: ContentThreadStreamService;

  constructor(billing: ContentBillingPort) {
    this.sourceIndexingService = new SourceIndexingService(billing);
    this.sourceParsingService = new SourceParsingService(
      this.sourceIndexingService,
    );
    this.threadStreamService = new ContentThreadStreamService(
      new ContentThreadTurnService(billing),
    );
  }

  async uploadSource(input: {
    workspaceId: string;
    userId: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
    sizeBytes: number;
  }) {
    return contentSourceService.uploadSource(input);
  }

  async createSource(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    estimatedPages?: number;
    parsedTokens?: number;
  }) {
    return contentSourceService.createSource(input);
  }

  async listSources(input: { workspaceId: string; userId: string }) {
    return contentSourceService.listSources(input);
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
  }) {
    return this.sourceParsingService.reparseSource(input);
  }

  async processSourceParseJob(input: SourceParseJobPayload) {
    return this.sourceParsingService.processSourceParseJob(input);
  }

  async processSourceParsePollJob(input: SourceParsePollJobPayload) {
    return this.sourceParsingService.processSourceParsePollJob(input);
  }

  async listByokKeyRefs(input: { workspaceId: string; userId: string }) {
    return contentByokService.listByokKeyRefs(input);
  }

  async createByokKeyRef(input: {
    workspaceId: string;
    userId: string;
    providerName: string;
    keyRef: string;
    apiKey: string;
    metadata?: Record<string, unknown>;
  }) {
    return contentByokService.createByokKeyRef(input);
  }

  async deleteByokKeyRef(input: {
    workspaceId: string;
    userId: string;
    providerName: string;
    keyRef: string;
  }) {
    return contentByokService.deleteByokKeyRef(input);
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

  async refreshThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }) {
    return this.threadStreamService.refreshThread(input);
  }

  async *refreshThreadEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }): AsyncGenerator<string> {
    yield* this.threadStreamService.refreshThreadEvents(input);
  }

  async editThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }) {
    return this.threadStreamService.editThread(input);
  }

  async *editThreadEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
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
}
