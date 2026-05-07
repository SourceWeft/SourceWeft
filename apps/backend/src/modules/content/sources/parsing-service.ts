import { createHash } from "node:crypto";
import { config } from "../../../shared/config";
import { ContentError } from "../errors";
import { getSourceParser, type ParsedDocument } from "../parsers";
import { startDocumentParse } from "../parsers/providers/document-parse-orchestrator";
import { getDocumentProviderForResume } from "../parsers/providers/registry";
import type { DocumentParseProviderId, ParsingConfig, SourceRecord, SourceStatusDetail } from "../types";
import { downloadSourceObject } from "../storage";
import {
  enqueueSourceParseJob,
  enqueueSourceParsePollJob,
  type SourceParseJobPayload,
  type SourceParsePollJobPayload,
} from "../queue";
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
import {
  normalizeContentTitle,
  requireContentSource,
} from "../content-support";
import { DEFAULT_PARSER_VERSION, defaultParsingConfig } from "./parsing-config";

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

function nextProviderPollDelay(attempt: number) {
  const initial = config.pdf2markdown.pollInitialDelayMs;
  const max = config.pdf2markdown.pollMaxDelayMs;
  return Math.min(max, initial * 2 ** Math.max(0, attempt));
}

export class SourceParsingService {
  constructor(private readonly sourceIndexingService: SourceIndexingService) {}

  async reparseSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    chunkSize?: number;
  }) {
    const { workspace, source } = await requireContentSource(input);
    if (!source.storageKey) {
      throw new ContentError(
        400,
        "SOURCE_NOT_UPLOADED",
        "Source has no uploaded file to reparse",
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
      parserVersion: parsingConfig.parserVersion,
    });

    const job = await enqueueSourceParseJob({
      sourceId: source.id,
      sourceRevisionId: revision.id,
      workspaceId: workspace.id,
      teamId: workspace.organizationId,
      userId: input.userId,
      idempotencyKey: `source_parse_${source.id}_${revision.revisionNo}`,
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

  async processSourceParseJob(input: SourceParseJobPayload) {
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

      const parsingConfig = defaultParsingConfig(source.parsingConfig ?? undefined);

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
      await this.failSource(input, source, error);
      throw error;
    }
  }

  async processSourceParsePollJob(input: SourceParsePollJobPayload) {
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
      await this.failSource(input, source, error);
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
    const parsedPages = input.parsed.pages.length;
    const billablePages = input.parsed.metadata.pageCount ?? parsedPages;
    const parsedSource = await updateSourceRecordForLatestRevision({
      teamId: input.input.teamId,
      workspaceId: input.input.workspaceId,
      sourceId: input.input.sourceId,
      sourceRevisionId: input.input.sourceRevisionId,
      title: normalizeContentTitle(input.parsed.title, input.source.title),
      contentText: input.parsed.content,
      contentHash,
      parserVersion: input.parsingConfig.parserVersion,
      parsingConfig: input.parsingConfig,
      estimatedPages: input.parsed.metadata.pageCount ?? input.source.estimatedPages,
      parsedTokens,
      metadata: {
        ...(input.source.metadata ?? {}),
        ...input.parsed.metadata,
        parsedPages: input.parsed.pages.length,
        totalPages: billablePages || input.parsed.pages.length,
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
      estimatedPages: input.parsed.metadata.pageCount,
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
        parsedPages: input.parsed.pages.length,
        totalPages: billablePages || input.parsed.pages.length,
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

    const message = error instanceof Error ? error.message : "Source parse failed";
    await updateSourceStatusForLatestRevision({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceRevisionId: input.sourceRevisionId,
      status: "failed",
      error: { message },
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
