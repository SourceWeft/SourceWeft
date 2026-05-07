import { config } from "../../../shared/config";
import { ContentError } from "../errors";
import {
  normalizeContentTitle,
  requireContentSource,
  requireContentWorkspace,
} from "../content-support";
import {
  createSourceRecord,
  createSourceRevisionRecord,
  deleteSourceRecord,
  getSourceDetailRecord,
  getSourceDocumentDetailRecord,
  getSourceStatusDetail,
  listSourceRecords,
  updateSourceRecordAndInvalidateDocuments,
  updateSourceRecord,
} from "./repository";
import {
  buildSourceStorageKey,
  getSourceObjectDownloadUrl,
  uploadSourceObject,
} from "../storage";
import { getSourceParser } from "../parsers";
import {
  assertSourceContentCanBeParsed,
  requireSupportedSourceFile,
} from "../source-file-classifier";
import { enqueueSourceParseJob } from "../queue";
import type { SourceRecord, SourceStatusDetail } from "../types";
import { defaultParsingConfig } from "./parsing-config";

function resolveUploadTitle(fileName: string) {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "Uploaded Source";
  }

  return normalizeContentTitle(
    trimmed.replace(/\.[^.]+$/, ""),
    "Uploaded Source",
  );
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

export class ContentSourceService {
  async uploadSource(input: {
    workspaceId: string;
    userId: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
    sizeBytes: number;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const classification = requireSupportedSourceFile({
      fileName: input.fileName,
      mimeType: input.mimeType,
    });
    assertSourceContentCanBeParsed({
      classification,
      content: input.content,
      fileName: input.fileName,
    });

    const parser = getSourceParser(classification.mimeType);
    if (!parser) {
      throw new ContentError(
        400,
        "UNSUPPORTED_SOURCE_TYPE",
        `Unsupported MIME type: ${classification.mimeType}`,
      );
    }

    const parsingConfig = defaultParsingConfig();
    const sourceMetadata = {
      fileName: input.fileName,
      fileSize: input.sizeBytes,
      mimeType: classification.mimeType,
      originalMimeType: classification.originalMimeType,
      sourceFileKind: classification.kind,
      sourceFileExtension: classification.extension,
      uploadMethod: "api" as const,
      progress: 0,
      currentStep: "uploading",
    };
    const source = await createSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: resolveUploadTitle(input.fileName),
      contentText: "",
      createdBy: input.userId,
      sourceType: "file_upload",
      mimeType: classification.mimeType,
      sizeBytes: input.sizeBytes,
      parserVersion: parsingConfig.parserVersion,
      parsingConfig,
      metadata: sourceMetadata,
    });

    const storageKey = buildSourceStorageKey({
      workspaceId: workspace.id,
      sourceId: source.id,
      fileName: input.fileName,
    });

    try {
      await uploadSourceObject({
        key: storageKey,
        body: input.content,
        contentType: classification.mimeType,
      });

      const updatedSource = await updateSourceRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        storageBucket: config.s3.bucket,
        storageKey,
        status: "queued",
        metadata: mergeStatusMetadata(source, {
          ...sourceMetadata,
          progress: 5,
          currentStep: "queued",
        }),
      });

      if (!updatedSource) {
        throw new ContentError(
          500,
          "SOURCE_UPLOAD_FAILED",
          "Failed to queue uploaded source",
        );
      }

      const revision = await createSourceRevisionRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: updatedSource.id,
        storageBucket: config.s3.bucket,
        storageKey,
        parserVersion: parsingConfig.parserVersion,
      });

      const job = await enqueueSourceParseJob({
        sourceId: updatedSource.id,
        sourceRevisionId: revision.id,
        workspaceId: workspace.id,
        teamId: workspace.organizationId,
        userId: input.userId,
        idempotencyKey: `source_parse_${updatedSource.id}_${revision.revisionNo}`,
      });

      const queuedSource = await updateSourceRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: updatedSource.id,
        metadata: mergeStatusMetadata(updatedSource, {
          progress: 10,
          currentStep: "queued",
          jobId: String(job.id),
        }),
      });

      const status = await getSourceStatusDetail({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: updatedSource.id,
      });

      return {
        source: queuedSource ?? updatedSource,
        status: status ?? {
          status: "queued",
          progress: 10,
          currentStep: "queued",
          parsedPages: null,
          totalPages: null,
          error: null,
          jobId: String(job.id),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Source upload failed";
      await updateSourceRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        status: "failed",
        error: { message },
        metadata: mergeStatusMetadata(source, {
          progress: 100,
          currentStep: "failed",
          error: message,
        }),
      });

      throw error;
    }
  }

  async createSource(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    estimatedPages?: number;
    parsedTokens?: number;
  }) {
    const workspace = await requireContentWorkspace(input);

    const source = await createSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeContentTitle(input.title, "Untitled Source"),
      contentText: input.contentText ?? "",
      createdBy: input.userId,
      estimatedPages: input.estimatedPages,
      parsedTokens: input.parsedTokens,
    });

    return { source };
  }

  async listSources(input: { workspaceId: string; userId: string }) {
    const workspace = await requireContentWorkspace(input);
    const items = await listSourceRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    return { items };
  }

  async getSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireContentSource(input);
    const detail = await getSourceDetailRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!detail) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return detail;
  }

  async getSourceDocument(input: {
    workspaceId: string;
    sourceId: string;
    documentId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireContentSource(input);
    const detail = await getSourceDocumentDetailRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      documentId: input.documentId,
    });

    if (!detail) {
      throw new ContentError(
        404,
        "DOCUMENT_NOT_FOUND",
        "Source document not found",
      );
    }

    return detail;
  }

  async getSourceStatus(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireContentSource(input);
    const detail = await getSourceStatusDetail({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!detail) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return detail;
  }

  async getSourceContent(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { source } = await requireContentSource(input);
    return {
      source,
      content: source.contentText,
    };
  }

  async downloadSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { source } = await requireContentSource(input);
    if (!source.storageKey) {
      throw new ContentError(
        400,
        "SOURCE_ORIGINAL_FILE_MISSING",
        "Source has no original uploaded file to download",
      );
    }

    const url = await getSourceObjectDownloadUrl({
      bucket: source.storageBucket ?? config.s3.bucket,
      key: source.storageKey,
      fileName: String(source.metadata.fileName || source.title || "source"),
      contentType: source.mimeType || "application/octet-stream",
    });

    return { url };
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
    const { workspace, source } = await requireContentSource(input);

    const nextTitle =
      input.title !== undefined
        ? normalizeContentTitle(input.title, source.title)
        : undefined;
    const updated =
      input.contentText !== undefined
        ? await updateSourceRecordAndInvalidateDocuments({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceId: source.id,
            title: nextTitle,
            contentText: input.contentText,
            estimatedPages: input.estimatedPages,
            parsedTokens: input.parsedTokens,
          })
        : await updateSourceRecord({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceId: source.id,
            title: nextTitle,
            estimatedPages: input.estimatedPages,
            parsedTokens: input.parsedTokens,
          });

    if (!updated) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return { source: updated };
  }

  async deleteSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireContentSource(input);
    const deleted = await deleteSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!deleted) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return {
      deleted: true as const,
      sourceId: source.id,
    };
  }
}

export const contentSourceService = new ContentSourceService();
