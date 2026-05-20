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
  findSourceRecord,
  findSourceRecordByExternalUri,
  getSourceDetailRecord,
  getSourceDocumentDetailRecord,
  getSourceStatusDetail,
  hasSourceChildren,
  listSourceDescendants,
  listSourceMentionRecords,
  listSourceRecords,
  listSourceRecordsByIds,
  listSourceRecordsByTitles,
  updateSourceRecordAndInvalidateDocuments,
  updateSourceRecord,
} from "./repository";
import {
  buildSourceStorageKey,
  getSourceObjectPreviewUrl,
  getSourceObjectDownloadUrl,
  uploadSourceObject,
} from "../storage";
import { getSourceParser } from "../parsers";
import { WEB_FETCH_SOURCE_MIME_TYPE } from "../parsers/web-fetch";
import {
  assertSourceContentCanBeParsed,
  requireSupportedSourceFile,
} from "../source-file-classifier";
import { enqueueSourceParseJob } from "../queue";
import type { SourceRecord, SourceStatusDetail } from "../types";
import { validatePublicHttpUrl } from "../web";
import { defaultParsingConfig } from "./parsing-config";

const SOURCE_TREE_MAX_DEPTH = 64;

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

function normalizeDirectoryTitleForConflict(value: string) {
  return value.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
}

function normalizeExternalUrl(value: string) {
  const url = new URL(validatePublicHttpUrl(value));
  url.hash = "";
  return url.toString();
}

function resolveUrlSourceTitle(input: { title?: string; url: string }) {
  const title = input.title?.trim();
  if (title) {
    return normalizeContentTitle(title, "Web Source");
  }

  try {
    const url = new URL(input.url);
    return normalizeContentTitle(
      url.hostname.replace(/^www\./, "") || input.url,
      "Web Source",
    );
  } catch {
    return normalizeContentTitle(input.url, "Web Source");
  }
}

async function assertNoDirectoryNameConflict(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  parentSourceId: string | null;
  sourceId?: string;
}) {
  const siblings = await listSourceRecords({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
  });
  const normalizedTitle = normalizeDirectoryTitleForConflict(input.title);
  const conflict = siblings.items.find((candidate) =>
    candidate.sourceType === "directory" &&
    candidate.id !== input.sourceId &&
    candidate.parentSourceId === input.parentSourceId &&
    normalizeDirectoryTitleForConflict(candidate.title) === normalizedTitle
  );

  if (conflict) {
    throw new ContentError(
      409,
      "DIRECTORY_NAME_CONFLICT",
      `A directory named "${input.title}" already exists in this location`,
    );
  }
}

async function validateSourceParent(input: {
  teamId: string;
  workspaceId: string;
  sourceId?: string;
  parentSourceId: string | null | undefined;
}) {
  if (input.parentSourceId === undefined || input.parentSourceId === null) {
    return null;
  }

  if (input.sourceId && input.parentSourceId === input.sourceId) {
    throw new ContentError(
      400,
      "INVALID_SOURCE_PARENT",
      "A source cannot be moved under itself",
    );
  }

  const parent = await findSourceRecord({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceId: input.parentSourceId,
  });
  if (!parent) {
    throw new ContentError(404, "SOURCE_PARENT_NOT_FOUND", "Parent source not found");
  }
  if (parent.sourceType !== "directory") {
    throw new ContentError(
      400,
      "INVALID_SOURCE_PARENT",
      "Parent source must be a directory",
    );
  }

  if (input.sourceId) {
    const descendants = await listSourceDescendants({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceIds: [input.sourceId],
      maxDepth: SOURCE_TREE_MAX_DEPTH,
    });
    if (descendants.some((descendant) => descendant.id === input.parentSourceId)) {
      throw new ContentError(
        400,
        "INVALID_SOURCE_PARENT",
        "A source cannot be moved under one of its descendants",
      );
    }
  }

  return parent;
}

export async function resolveSourceTreeScope(input: {
  teamId: string;
  workspaceId: string;
  selectedSourceIds: string[];
}) {
  const requestedSourceIds = Array.from(new Set(input.selectedSourceIds));
  if (requestedSourceIds.length === 0) {
    return {
      requestedSourceIds,
      effectiveSourceIds: [],
      selectedDirectoryIds: [],
      expandedDescendantSourceIds: [],
    };
  }

  const selectedSources = await listSourceRecordsByIds({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceIds: requestedSourceIds,
  });
  const selectedById = new Map(selectedSources.map((source) => [source.id, source]));
  const selectedDirectoryIds = requestedSourceIds.filter(
    (sourceId) => selectedById.get(sourceId)?.sourceType === "directory",
  );
  const descendants = await listSourceDescendants({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceIds: selectedDirectoryIds,
    maxDepth: SOURCE_TREE_MAX_DEPTH,
  });
  const expandedDescendantSourceIds = descendants.map((source) => source.id);
  const effectiveSourceIds = Array.from(
    new Set([...requestedSourceIds, ...expandedDescendantSourceIds]),
  );

  return {
    requestedSourceIds,
    effectiveSourceIds,
    selectedDirectoryIds,
    expandedDescendantSourceIds,
  };
}

export async function resolveSourceIdsByTitles(input: {
  teamId: string;
  workspaceId: string;
  titles: string[];
}) {
  const records = await listSourceRecordsByTitles(input);
  const byTitle = new Map(records.map((record) => [record.title, record.id]));
  return input.titles
    .map((title) => byTitle.get(title.trim()))
    .filter((sourceId): sourceId is string => typeof sourceId === "string");
}

export function resolveRecursiveSourceDeleteOrder(input: {
  requestedSourceIds: string[];
  selectedSources: Pick<SourceRecord, "id" | "parentSourceId" | "sourceType">[];
  descendants: Pick<SourceRecord, "id" | "parentSourceId">[];
}) {
  const selectedById = new Map(
    input.selectedSources.map((source) => [source.id, source]),
  );
  const effectiveSources = new Map<
    string,
    Pick<SourceRecord, "id" | "parentSourceId">
  >();

  for (const source of [...input.selectedSources, ...input.descendants]) {
    if (!effectiveSources.has(source.id)) {
      effectiveSources.set(source.id, source);
    }
  }

  const childrenByParentId = new Map<string, string[]>();
  for (const source of effectiveSources.values()) {
    if (!source.parentSourceId || !effectiveSources.has(source.parentSourceId)) {
      continue;
    }
    const children = childrenByParentId.get(source.parentSourceId) ?? [];
    children.push(source.id);
    childrenByParentId.set(source.parentSourceId, children);
  }

  const selectedDirectoryIds = input.requestedSourceIds.filter(
    (sourceId) => selectedById.get(sourceId)?.sourceType === "directory",
  );
  const roots = [
    ...selectedDirectoryIds,
    ...input.requestedSourceIds,
    ...Array.from(effectiveSources.keys()),
  ];
  const visited = new Set<string>();
  const ordered: string[] = [];

  function visit(sourceId: string) {
    if (visited.has(sourceId) || !effectiveSources.has(sourceId)) {
      return;
    }
    visited.add(sourceId);
    for (const childId of childrenByParentId.get(sourceId) ?? []) {
      visit(childId);
    }
    ordered.push(sourceId);
  }

  for (const sourceId of roots) {
    visit(sourceId);
  }

  return ordered;
}

export function shouldRejectSingleSourceDelete(input: {
  sourceType: SourceRecord["sourceType"];
  hasChildren: boolean;
}) {
  return input.sourceType === "directory" && input.hasChildren;
}

export class ContentSourceService {
  private async attachSourceUrls(source: SourceRecord) {
    if (!source.storageKey) {
      return source;
    }

    const fileName = String(source.metadata.fileName || source.title || "source");
    const contentType = source.mimeType || "application/octet-stream";
    const [previewUrl, downloadUrl] = await Promise.all([
      getSourceObjectPreviewUrl({
        bucket: source.storageBucket ?? config.s3.bucket,
        key: source.storageKey,
        fileName,
        contentType,
      }),
      getSourceObjectDownloadUrl({
        bucket: source.storageBucket ?? config.s3.bucket,
        key: source.storageKey,
        fileName,
        contentType,
      }),
    ]);

    return {
      ...source,
      previewUrl,
      downloadUrl,
    };
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
    await validateSourceParent({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      parentSourceId: input.parentSourceId,
    });
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
      parentSourceId: input.parentSourceId ?? null,
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
    sourceType?: SourceRecord["sourceType"];
    parentSourceId?: string | null;
    estimatedPages?: number;
    parsedTokens?: number;
  }) {
    const workspace = await requireContentWorkspace(input);
    const sourceType = input.sourceType ?? "manual_upload";
    if (sourceType !== "manual_upload" && sourceType !== "directory") {
      throw new ContentError(
        400,
        "UNSUPPORTED_SOURCE_TYPE",
        `Source type '${sourceType}' cannot be created from this endpoint`,
      );
    }
    const title = normalizeContentTitle(
      input.title,
      sourceType === "directory" ? "Untitled Folder" : "Untitled Source",
    );

    await validateSourceParent({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      parentSourceId: input.parentSourceId,
    });
    if (sourceType === "directory") {
      await assertNoDirectoryNameConflict({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        parentSourceId: input.parentSourceId ?? null,
        title,
      });
    }

    const contentText = input.contentText ?? "";
    const emptyDirectory = sourceType === "directory" && contentText.trim().length === 0;

    const source = await createSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title,
      contentText,
      createdBy: input.userId,
      sourceType,
      parentSourceId: input.parentSourceId ?? null,
      status: emptyDirectory ? "indexed" : undefined,
      indexedAt: emptyDirectory ? new Date() : undefined,
      estimatedPages: input.estimatedPages,
      parsedTokens: input.parsedTokens,
    });

    return { source };
  }

  async createUrlSource(input: {
    workspaceId: string;
    userId: string;
    url: string;
    title?: string;
    parentSourceId?: string | null;
    forceRefresh?: boolean;
  }) {
    const workspace = await requireContentWorkspace(input);
    const externalUri = normalizeExternalUrl(input.url);

    await validateSourceParent({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      parentSourceId: input.parentSourceId,
    });

    const existing = await findSourceRecordByExternalUri({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceType: "web_url",
      externalUri,
    });
    if (existing && input.forceRefresh !== true) {
      return {
        source: existing,
        status: (await getSourceStatusDetail({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          sourceId: existing.id,
        })) ?? {
          status: existing.status,
          progress: existing.status === "indexed" ? 100 : 0,
          currentStep: existing.status === "indexed" ? "completed" : "created",
          parsedPages: null,
          totalPages: null,
          error: null,
          jobId: null,
        },
      };
    }

    const parsingConfig = defaultParsingConfig();
    const now = new Date();
    const sourceMetadata = {
      loaderId: "web-fetch",
      parserId: "web-fetch",
      requestedUrl: externalUri,
      sourceUrl: externalUri,
      forceRefresh: input.forceRefresh === true,
      userTitleProvided: Boolean(input.title?.trim()),
      progress: 0,
      currentStep: "created",
    };
    const source = existing
      ? await updateSourceRecord({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          sourceId: existing.id,
          title: input.title
            ? resolveUrlSourceTitle({ title: input.title, url: externalUri })
            : undefined,
          parentSourceId: input.parentSourceId,
          externalUri,
          externalUpdatedAt: now,
          mimeType: WEB_FETCH_SOURCE_MIME_TYPE,
          sizeBytes: Buffer.byteLength(externalUri, "utf8"),
          parserVersion: parsingConfig.parserVersion,
          parsingConfig,
          status: "queued",
          error: {},
          metadata: {
            ...(existing.metadata ?? {}),
            ...sourceMetadata,
            progress: 5,
            currentStep: "queued",
            queuedAt: now.toISOString(),
          },
        })
      : await createSourceRecord({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          title: resolveUrlSourceTitle({ title: input.title, url: externalUri }),
          contentText: "",
          createdBy: input.userId,
          ingestKind: "web_url",
          sourceType: "web_url",
          parentSourceId: input.parentSourceId ?? null,
          externalUri,
          externalUpdatedAt: now,
          mimeType: WEB_FETCH_SOURCE_MIME_TYPE,
          sizeBytes: Buffer.byteLength(externalUri, "utf8"),
          parserVersion: parsingConfig.parserVersion,
          parsingConfig,
          status: "queued",
          metadata: {
            ...sourceMetadata,
            progress: 5,
            currentStep: "queued",
            queuedAt: now.toISOString(),
          },
        });

    if (!source) {
      throw new ContentError(
        500,
        "URL_SOURCE_CREATE_FAILED",
        "Failed to create URL source",
      );
    }

    const revision = await createSourceRevisionRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      parserVersion: parsingConfig.parserVersion,
      externalUpdatedAt: now,
    });

    const job = await enqueueSourceParseJob({
      sourceId: source.id,
      sourceRevisionId: revision.id,
      workspaceId: workspace.id,
      teamId: workspace.organizationId,
      userId: input.userId,
      idempotencyKey: `source_parse_${source.id}_${revision.revisionNo}`,
      forceRefresh: input.forceRefresh === true,
    });

    const queuedSource = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      metadata: mergeStatusMetadata(source, {
        progress: 10,
        currentStep: "queued",
        jobId: String(job.id),
      }),
    });

    return {
      source: queuedSource ?? source,
      status: (await getSourceStatusDetail({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
      })) ?? {
        status: "queued",
        progress: 10,
        currentStep: "queued",
        parsedPages: null,
        totalPages: null,
        error: null,
        jobId: String(job.id),
      },
    };
  }

  async listSources(input: {
    view?: "tree" | "page";
    includeContent?: boolean;
    limit?: number;
    cursor?: string;
    parentSourceId?: string | null;
    connectorId?: string;
    syncRunId?: string;
    updatedAfter?: string;
    workspaceId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    const result = await listSourceRecords({
      view: input.view,
      includeContent: input.view === "tree" ? false : input.includeContent,
      limit: input.view === "tree" ? undefined : input.limit,
      cursor: input.view === "tree" ? undefined : input.cursor,
      parentSourceId: input.view === "tree" ? undefined : input.parentSourceId,
      connectorId: input.connectorId,
      syncRunId: input.syncRunId,
      updatedAfter: input.updatedAfter ? new Date(input.updatedAfter) : undefined,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    return result;
  }

  async listSourceMentions(input: {
    workspaceId: string;
    userId: string;
    query?: string;
    limit?: number;
    cursor?: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    return listSourceMentionRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      query: input.query,
      limit: input.limit ?? 20,
      cursor: input.cursor,
    });
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

    return {
      ...detail,
      source: await this.attachSourceUrls(detail.source),
    };
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

    return {
      ...detail,
      source: await this.attachSourceUrls(detail.source),
    };
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

  async listSourceStatuses(input: {
    workspaceId: string;
    sourceIds: string[];
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const sourceIds = Array.from(
      new Set(input.sourceIds.map((id) => id.trim()).filter(Boolean)),
    );
    const sources = await listSourceRecordsByIds({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceIds,
    });
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const items = await Promise.all(
      sourceIds
        .filter((sourceId) => sourceById.has(sourceId))
        .map(async (sourceId) => {
          const detail = await getSourceStatusDetail({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceId,
          });
          const source = sourceById.get(sourceId);
          return detail || source
            ? {
                id: sourceId,
                status: detail ?? {
                  status: source?.status ?? "created",
                  progress: source?.status === "indexed" ? 100 : 0,
                  currentStep:
                    source?.status === "indexed" ? "completed" : "created",
                  parsedPages: null,
                  totalPages: null,
                  error: null,
                  jobId: null,
                },
              }
            : null;
        }),
    );

    return {
      items: items.filter(
        (item): item is NonNullable<(typeof items)[number]> => item !== null,
      ),
    };
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
    parentSourceId?: string | null;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
  }) {
    const { workspace, source } = await requireContentSource(input);

    const nextTitle =
      input.title !== undefined
        ? normalizeContentTitle(input.title, source.title)
        : undefined;
    const nextParentSourceId =
      input.parentSourceId !== undefined ? input.parentSourceId : undefined;
    if (nextParentSourceId !== undefined) {
      await validateSourceParent({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        parentSourceId: nextParentSourceId,
      });
    }
    if (source.sourceType === "directory" && (nextTitle !== undefined || nextParentSourceId !== undefined)) {
      await assertNoDirectoryNameConflict({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        parentSourceId: nextParentSourceId !== undefined
          ? nextParentSourceId
          : source.parentSourceId,
        title: nextTitle ?? source.title,
      });
    }
    const directoryContentCleared =
      source.sourceType === "directory" &&
      input.contentText !== undefined &&
      input.contentText.trim().length === 0;
    const updated =
      directoryContentCleared
        ? await updateSourceRecordAndInvalidateDocuments({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceId: source.id,
            title: nextTitle,
            parentSourceId: nextParentSourceId,
            contentText: "",
            status: "indexed",
            indexedAt: new Date(),
            estimatedPages: input.estimatedPages,
            parsedTokens: input.parsedTokens,
          })
        : input.contentText !== undefined
        ? await updateSourceRecordAndInvalidateDocuments({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceId: source.id,
            title: nextTitle,
            contentText: input.contentText,
            parentSourceId: nextParentSourceId,
            estimatedPages: input.estimatedPages,
            parsedTokens: input.parsedTokens,
          })
        : await updateSourceRecord({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceId: source.id,
            title: nextTitle,
            parentSourceId: nextParentSourceId,
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
    const hasChildren =
      source.sourceType === "directory"
        ? await hasSourceChildren({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceId: source.id,
          })
        : false;
    if (
      shouldRejectSingleSourceDelete({
        sourceType: source.sourceType,
        hasChildren,
      })
    ) {
      throw new ContentError(
        409,
        "DIRECTORY_NOT_EMPTY",
        "Directory must be empty before it can be deleted",
      );
    }
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

  async bulkDeleteSources(input: {
    workspaceId: string;
    sourceIds: string[];
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const requestedSourceIds = Array.from(new Set(input.sourceIds));
    const selectedSources = await listSourceRecordsByIds({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceIds: requestedSourceIds,
    });
    const selectedById = new Map(
      selectedSources.map((source) => [source.id, source]),
    );
    const missingSourceId = requestedSourceIds.find(
      (sourceId) => !selectedById.has(sourceId),
    );
    if (missingSourceId) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    const selectedDirectoryIds = requestedSourceIds.filter(
      (sourceId) => selectedById.get(sourceId)?.sourceType === "directory",
    );
    const descendants =
      selectedDirectoryIds.length > 0
        ? await listSourceDescendants({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            sourceIds: selectedDirectoryIds,
            maxDepth: SOURCE_TREE_MAX_DEPTH,
          })
        : [];
    const deleteOrder = resolveRecursiveSourceDeleteOrder({
      requestedSourceIds,
      selectedSources,
      descendants,
    });
    const deletedSourceIds: string[] = [];

    for (const sourceId of deleteOrder) {
      const deleted = await deleteSourceRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId,
      });
      if (!deleted) {
        throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
      }
      deletedSourceIds.push(sourceId);
    }

    return {
      deleted: true as const,
      sourceIds: deletedSourceIds,
      deletedCount: deletedSourceIds.length,
    };
  }
}

export const contentSourceService = new ContentSourceService();
