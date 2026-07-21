import { createHash } from "node:crypto";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import type { ContentBillingPort } from "../content/billing-port";
import { ContentError } from "../content/errors";
import { getSourceParser, type ParsedDocument } from "./parsers";
import {
  webFetchSourceParser,
  WEB_FETCH_SOURCE_MIME_TYPE,
} from "./parsers/web-fetch";
import { startDocumentParse } from "./parsers/providers/document-parse-orchestrator";
import { getDocumentProviderForResume } from "./parsers/providers/registry";
import { isSupportedImageMimeType } from "./parsers/providers/utils";
import type {
  DocumentParseProviderId,
  ParsingConfig,
  SourceRecord,
  SourceStatusDetail,
} from "../content/types";
import { downloadSourceObject } from "./storage";
import {
  enqueueSourceParseJob,
  enqueueSourceParsePollJob,
  type SourceParseJobPayload,
  type SourceParsePollJobPayload,
} from "../content/queue";
import {
  createSourceRevisionRecord,
  findLatestSourceRevisionRecord,
  findSourceRecord,
  getSourceStatusDetail,
  updateSourceRecordForLatestRevision,
  updateSourceRecord,
  updateSourceStatus,
  updateSourceStatusForLatestRevision,
} from "./repository";
import type { SourceIndexingService } from "./indexing-service";
import { requireContentSource } from "./guards";
import { normalizeContentTitle } from "../../shared/strings";
import { DEFAULT_PARSER_VERSION, defaultParsingConfig } from "./parsing-config";
import {
  buildSourceParseErrorLogContext,
  buildSourceParseFailureError,
  buildSourceParseLogContext,
} from "./parse-diagnostics";

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function computeContentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function mergeStatusMetadata(
  source: SourceRecord,
  status: Partial<SourceStatusDetail> & Record<string, unknown>,
) {
  return {
    ...(source.metadata ?? {}),
    ...status,
  };
}

function isDocumentProviderMimeType(mimeType: string) {
  return [
    "application/pdf",
    "image/avif",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/tiff",
    "image/bmp",
    "image/gif",
  ].includes(mimeType);
}

function resolveParsedPageCount(input: {
  mimeType?: string | null;
  parsed: ParsedDocument;
}) {
  if (input.mimeType && isSupportedImageMimeType(input.mimeType)) {
    return 1;
  }

  return input.parsed.metadata.pageCount ?? input.parsed.pages.length;
}

function isImageSourceMimeType(mimeType?: string | null) {
  return Boolean(mimeType && isSupportedImageMimeType(mimeType));
}

function nextProviderPollDelay(attempt: number) {
  const initial = config.pdf2markdown.pollInitialDelayMs;
  const max = config.pdf2markdown.pollMaxDelayMs;
  return Math.min(max, initial * 2 ** Math.max(0, attempt));
}

export class SourceParsingService {
  constructor(
    private readonly sourceIndexingService: SourceIndexingService,
    private readonly billing: ContentBillingPort,
  ) {}

  async tryQueueSourceReparse(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    chunkSize?: number;
    forceRefresh?: boolean;
  }) {
    const { source } = await requireContentSource(input);
    if (!source.storageKey && source.sourceType !== "web_url") {
      return null;
    }
    return this.reparseSource(input);
  }

  async reparseSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    chunkSize?: number;
    forceRefresh?: boolean;
  }) {
    const { workspace, source } = await requireContentSource(input);
    if (!source.storageKey && source.sourceType !== "web_url") {
      throw new ContentError(
        400,
        "SOURCE_NOT_UPLOADED",
        "Source has no uploaded file to reparse",
      );
    }
    if (source.sourceType === "web_url" && !source.externalUri) {
      throw new ContentError(
        400,
        "WEB_SOURCE_URL_MISSING",
        "Web source URL is missing",
      );
    }

    const parsingConfig = defaultParsingConfig({
      chunkSize: input.chunkSize,
      parserVersion: source.parserVersion ?? DEFAULT_PARSER_VERSION,
    });

    const updatedSource = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      parsingConfig,
      status: "queued",
      error: {},
      metadata: mergeStatusMetadata(source, {
        progress: 10,
        currentStep: "queued",
        error: null,
      }),
    });

    if (!updatedSource) {
      throw new ContentError(
        500,
        "SOURCE_REPARSE_FAILED",
        "Failed to queue source reparse",
      );
    }

    const revision = await createSourceRevisionRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      contentHash: source.contentHash,
      storageBucket: source.storageBucket,
      storageKey: source.storageKey,
      externalUpdatedAt: source.externalUpdatedAt
        ? new Date(source.externalUpdatedAt)
        : null,
      parserVersion: parsingConfig.parserVersion,
    });

    const job = await enqueueSourceParseJob({
      sourceId: source.id,
      sourceRevisionId: revision.id,
      workspaceId: workspace.id,
      teamId: workspace.organizationId,
      userId: input.userId,
      idempotencyKey: `source_parse_${source.id}_${revision.revisionNo}`,
      forceRefresh: input.forceRefresh,
    });

    const queuedSource = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      metadata: mergeStatusMetadata(updatedSource, {
        progress: 10,
        currentStep: "queued",
        jobId: String(job.id),
      }),
    });

    return {
      source: queuedSource ?? updatedSource,
      status: (await getSourceStatusDetail({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
      }))!,
      revision,
    };
  }

  async processSourceParseJob(
    input: SourceParseJobPayload & { isFinalAttempt?: boolean },
  ) {
    const source = await findSourceRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    if (!source) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    if (!(await this.isCurrentRevision(input))) {
      return;
    }

    try {
      if (source.sourceType === "web_url") {
        await this.processWebUrlSourceParseJob({
          input,
          source,
        });
        return;
      }

      if (!source.storageKey || !source.mimeType) {
        throw new ContentError(
          400,
          "SOURCE_STORAGE_MISSING",
          "Source file storage is incomplete",
        );
      }

      const parser = getSourceParser(source.mimeType);
      if (!parser) {
        throw new ContentError(
          400,
          "UNSUPPORTED_SOURCE_TYPE",
          `Unsupported MIME type: ${source.mimeType}`,
        );
      }

      const parsingConfig = defaultParsingConfig(
        source.parsingConfig ?? undefined,
      );

      const processingSource = await updateSourceStatusForLatestRevision({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        sourceRevisionId: input.sourceRevisionId,
        status: "processing",
        error: {},
        metadata: mergeStatusMetadata(source, {
          progress: 20,
          currentStep: "parsing",
        }),
      });
      if (!processingSource) {
        return;
      }

      const fileBuffer = await downloadSourceObject({
        bucket: source.storageBucket,
        key: source.storageKey,
      });
      const parseInput = {
        fileName: source.metadata.fileName || source.title,
        mimeType: source.mimeType,
        fileSize: source.sizeBytes ?? fileBuffer.length,
        content: fileBuffer,
        config: parsingConfig,
        sourceId: input.sourceId,
        sourceRevisionId: input.sourceRevisionId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        billing: this.billing,
      };
      const providerOutcome = isDocumentProviderMimeType(source.mimeType)
        ? await startDocumentParse({
            ...parseInput,
            sourceId: input.sourceId,
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            userId: input.userId,
          })
        : null;

      if (providerOutcome?.kind === "pending") {
        await updateSourceRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          metadata: mergeStatusMetadata(source, {
            ...(providerOutcome.diagnostics?.metadata ?? {}),
            progress: 30,
            currentStep: "parsing",
          }),
        });

        await enqueueSourceParsePollJob(
          {
            sourceId: input.sourceId,
            sourceRevisionId: input.sourceRevisionId,
            workspaceId: input.workspaceId,
            teamId: input.teamId,
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
            backendId: providerOutcome.token.backendId,
            taskId: providerOutcome.token.taskId,
            fileName: providerOutcome.token.fileName,
            mimeType: providerOutcome.token.mimeType,
            fileSize: providerOutcome.token.fileSize,
            parsingConfig,
            attempt: 0,
          },
          nextProviderPollDelay(0),
        );
        return;
      }

      const parsed =
        providerOutcome?.kind === "completed"
          ? providerOutcome.document
          : await parser.parse(parseInput);

      await this.completeParsedSource({ input, source, parsed, parsingConfig });
    } catch (error) {
      logger.error("Source parse failed", {
        ...buildSourceParseLogContext({ job: input, source }),
        ...buildSourceParseErrorLogContext(error),
      });
      if (input.isFinalAttempt !== false) {
        await this.failSource(input, source, error);
      }
      throw error;
    }
  }

  private async processWebUrlSourceParseJob(input: {
    input: SourceParseJobPayload;
    source: SourceRecord;
  }) {
    if (!input.source.externalUri) {
      throw new ContentError(
        400,
        "WEB_SOURCE_URL_MISSING",
        "Web source URL is missing",
      );
    }

    const parsingConfig = defaultParsingConfig(
      input.source.parsingConfig ?? undefined,
    );
    const processingSource = await updateSourceStatusForLatestRevision({
      teamId: input.input.teamId,
      workspaceId: input.input.workspaceId,
      sourceId: input.input.sourceId,
      sourceRevisionId: input.input.sourceRevisionId,
      status: "processing",
      error: {},
      metadata: mergeStatusMetadata(input.source, {
        progress: 20,
        currentStep: "parsing",
      }),
    });
    if (!processingSource) {
      return;
    }

    const urlBuffer = Buffer.from(input.source.externalUri, "utf8");
    const parsed = await webFetchSourceParser.parse({
      fileName: input.source.title,
      mimeType: input.source.mimeType || WEB_FETCH_SOURCE_MIME_TYPE,
      fileSize: input.source.sizeBytes ?? urlBuffer.length,
      content: urlBuffer,
      config: parsingConfig,
      sourceExternalUri: input.source.externalUri,
      forceRefresh: input.input.forceRefresh,
      preferInputTitle: input.source.metadata.userTitleProvided === true,
      sourceId: input.input.sourceId,
      sourceRevisionId: input.input.sourceRevisionId,
      teamId: input.input.teamId,
      workspaceId: input.input.workspaceId,
      userId: input.input.userId,
      idempotencyKey: input.input.idempotencyKey,
    });

    await this.completeParsedSource({
      input: input.input,
      source: input.source,
      parsed,
      parsingConfig,
    });
  }

  async processSourceParsePollJob(
    input: SourceParsePollJobPayload & { isFinalAttempt?: boolean },
  ) {
    const source = await findSourceRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    if (!source) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    if (!(await this.isCurrentRevision(input))) {
      return;
    }

    try {
      if (!source.storageKey) {
        throw new ContentError(
          400,
          "SOURCE_STORAGE_MISSING",
          "Source file storage is incomplete",
        );
      }

      const provider = getDocumentProviderForResume(
        input.backendId as DocumentParseProviderId,
      );
      const fileBuffer = await downloadSourceObject({
        bucket: source.storageBucket,
        key: source.storageKey,
      });

      const outcome = await provider.resume(
        {
          backendId: input.backendId as DocumentParseProviderId,
          taskId: input.taskId,
          sourceId: input.sourceId,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          parsingConfig: input.parsingConfig,
          attempt: input.attempt,
        },
        fileBuffer,
      );

      if (outcome.kind === "pending") {
        if (!(await this.isCurrentRevision(input))) {
          return;
        }

        if (outcome.token.attempt >= config.pdf2markdown.pollMaxAttempts) {
          throw new ContentError(
            504,
            "PROVIDER_PARSE_TIMEOUT",
            "Document parse provider timed out",
          );
        }

        await updateSourceRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          metadata: mergeStatusMetadata(source, {
            ...(outcome.diagnostics?.metadata ?? {}),
            progress: Math.min(55, 30 + outcome.token.attempt),
            currentStep: "parsing",
          }),
        });

        await enqueueSourceParsePollJob(
          {
            ...input,
            attempt: outcome.token.attempt,
          },
          nextProviderPollDelay(outcome.token.attempt),
        );
        return;
      }

      await this.completeParsedSource({
        input,
        source,
        parsed: outcome.document,
        parsingConfig: input.parsingConfig,
      });
    } catch (error) {
      logger.error("Source parse poll failed", {
        ...buildSourceParseLogContext({ job: input, source }),
        backendId: input.backendId,
        taskId: input.taskId,
        providerMimeType: input.mimeType,
        pollAttempt: input.attempt,
        ...buildSourceParseErrorLogContext(error),
      });
      if (input.isFinalAttempt !== false) {
        await this.failSource(input, source, error);
      }
      throw error;
    }
  }

  private async completeParsedSource(input: {
    input: SourceParseJobPayload;
    source: SourceRecord;
    parsed: ParsedDocument;
    parsingConfig: ParsingConfig;
  }) {
    if (!(await this.isCurrentRevision(input.input))) {
      return;
    }

    const contentHash = computeContentHash(input.parsed.content);
    const parsedTokens = estimateTokens(input.parsed.content);
    const parsedPages = resolveParsedPageCount({
      mimeType: input.source.mimeType,
      parsed: input.parsed,
    });
    const billablePages = parsedPages;
    const imagePageMetadata = isImageSourceMimeType(input.source.mimeType)
      ? { pageCount: parsedPages }
      : {};
    const parsedSource = await updateSourceRecordForLatestRevision({
      teamId: input.input.teamId,
      workspaceId: input.input.workspaceId,
      sourceId: input.input.sourceId,
      sourceRevisionId: input.input.sourceRevisionId,
      title: normalizeContentTitle(input.parsed.title, input.source.title),
      contentText: input.parsed.content,
      contentHash,
      sizeBytes: Buffer.byteLength(input.parsed.content, "utf8"),
      parserVersion: input.parsingConfig.parserVersion,
      parsingConfig: input.parsingConfig,
      estimatedPages: parsedPages || input.source.estimatedPages,
      parsedTokens,
      metadata: {
        ...(input.source.metadata ?? {}),
        ...input.parsed.metadata,
        ...imagePageMetadata,
        parsedPages,
        totalPages: billablePages || parsedPages,
        progress: 60,
        currentStep: "chunking",
        error: null,
      },
    });

    if (!parsedSource) {
      return;
    }

    const result = await this.sourceIndexingService.indexSourceRevision({
      workspaceId: input.input.workspaceId,
      sourceId: input.input.sourceId,
      userId: input.input.userId,
      sourceRevisionId: input.input.sourceRevisionId,
      estimatedPages: parsedPages,
      parsedPages: billablePages || parsedPages,
      parsedTokens,
      idempotencyKey: input.input.idempotencyKey,
      chunks: input.parsed.chunks,
    });

    if ("stale" in result && result.stale) {
      return;
    }

    if (!(await this.isCurrentRevision(input.input))) {
      return;
    }

    await updateSourceRecordForLatestRevision({
      teamId: input.input.teamId,
      workspaceId: input.input.workspaceId,
      sourceId: input.input.sourceId,
      sourceRevisionId: input.input.sourceRevisionId,
      metadata: mergeStatusMetadata(result.source, {
        parsedPages,
        totalPages: billablePages || parsedPages,
        progress: 100,
        currentStep: "completed",
        error: null,
      }),
      error: {},
    });
  }

  private async failSource(
    input: SourceParseJobPayload,
    source: SourceRecord,
    error: unknown,
  ) {
    const isCurrentRevision = await this.isCurrentRevision(input);
    if (!isCurrentRevision) {
      return;
    }

    const failure = buildSourceParseFailureError({ source, error });
    const message =
      typeof failure.message === "string"
        ? failure.message
        : "Source parse failed";
    await updateSourceStatusForLatestRevision({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceRevisionId: input.sourceRevisionId,
      status: "failed",
      error: failure,
      metadata: {
        ...(source.metadata ?? {}),
        progress: 100,
        currentStep: "failed",
        error: message,
      },
    });
  }

  private async isCurrentRevision(input: SourceParseJobPayload) {
    const latestRevision = await findLatestSourceRevisionRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    return latestRevision?.id === input.sourceRevisionId;
  }
}
