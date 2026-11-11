import type {
  ConnectorExtractedFileDescriptor,
  ConnectorItemSkipReason,
} from "./types";
import { isConnectorItemSkipError } from "./types";
import { classifySourceFile } from "../sources/source-file-classifier";
import {
  DocumentNeedsOcrError,
  isDocumentProviderMimeType,
  startDocumentParse,
} from "../sources/parsers/providers/document-parse-orchestrator";
import { getSourceParser } from "../sources/parsers";
import { defaultParsingConfig } from "../sources/parsing-config";
import { estimateSourceTokens } from "../sources/billing-pages";

export const CONNECTOR_FILE_MAX_BYTES = 20 * 1024 * 1024;

export type ResolvedExtractedFile =
  | {
      kind: "parsed";
      contentText: string;
      parsedMetadata: Record<string, unknown>;
      mimeType: string;
    }
  | { kind: "skipped"; reason: ConnectorItemSkipReason };

export type ExtractedFileDeps = {
  classify: typeof classifySourceFile;
  isDocumentMime: typeof isDocumentProviderMimeType;
  parseDocument: typeof startDocumentParse;
  getTextParser: typeof getSourceParser;
};

const defaultDeps: ExtractedFileDeps = {
  classify: classifySourceFile,
  isDocumentMime: isDocumentProviderMimeType,
  parseDocument: startDocumentParse,
  getTextParser: getSourceParser,
};

/** These classifier kinds are never resolvable by a connector sync; the item
 * is skipped before any download is attempted. */
const UNSUPPORTED_CLASSIFIER_KINDS = new Set(["image", "audio", "transcript"]);

function skipped(reason: ConnectorItemSkipReason): ResolvedExtractedFile {
  return { kind: "skipped", reason };
}

/**
 * Resolves a connector's extracted file descriptor into parsed text or a
 * typed skip reason. Mirrors the processing order used for uploaded sources
 * (classify → size check → download → parse → blank-content check) so a
 * connector-synced file is subject to the same rules as a manually uploaded
 * one, with OCR always denied — connector sync must never invoke OCR.
 */
export async function resolveExtractedFile(input: {
  file: ConnectorExtractedFileDescriptor;
  teamId: string;
  workspaceId: string;
  userId: string;
  externalUri: string | null;
  deps?: Partial<ExtractedFileDeps>;
}): Promise<ResolvedExtractedFile> {
  const deps: ExtractedFileDeps = { ...defaultDeps, ...input.deps };

  const classification = deps.classify({
    fileName: input.file.fileName,
    mimeType: input.file.mimeType,
  });

  if (
    !classification.supported ||
    UNSUPPORTED_CLASSIFIER_KINDS.has(classification.kind)
  ) {
    return skipped("unsupported_type");
  }

  if (
    input.file.sizeBytes !== null &&
    input.file.sizeBytes > CONNECTOR_FILE_MAX_BYTES
  ) {
    return skipped("too_large");
  }

  let content: Buffer;
  try {
    content = await input.file.download({
      maxBytes: CONNECTOR_FILE_MAX_BYTES,
    });
  } catch (error) {
    if (isConnectorItemSkipError(error)) {
      return skipped(error.reason);
    }
    throw error;
  }

  if (content.byteLength > CONNECTOR_FILE_MAX_BYTES) {
    return skipped("too_large");
  }

  const parseInput = {
    fileName: input.file.fileName,
    mimeType: classification.mimeType,
    fileSize: content.byteLength,
    content,
    config: defaultParsingConfig(),
    sourceExternalUri: input.externalUri ?? undefined,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  };

  let contentText: string;
  let parsedMetadata: Record<string, unknown>;

  if (deps.isDocumentMime(classification.mimeType)) {
    let outcome;
    try {
      outcome = await deps.parseDocument({
        ...parseInput,
        sourceId: "",
        ocr: "deny",
      });
    } catch (error) {
      if (error instanceof DocumentNeedsOcrError) {
        return skipped("needs_ocr");
      }
      throw error;
    }

    if (outcome.kind !== "completed") {
      throw new Error(
        `Connector document parse did not complete (kind: ${outcome.kind})`,
      );
    }

    contentText = outcome.document.content;
    parsedMetadata = outcome.document.metadata;
  } else {
    const parser = deps.getTextParser(classification.mimeType);
    if (!parser) {
      return skipped("unsupported_type");
    }

    const parsed = await parser.parse(parseInput);
    contentText = parsed.content;
    parsedMetadata = parsed.metadata;
  }

  if (estimateSourceTokens(contentText) === 0) {
    return skipped("empty_content");
  }

  return {
    kind: "parsed",
    contentText,
    parsedMetadata,
    mimeType: classification.mimeType,
  };
}
