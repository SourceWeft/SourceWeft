import { ParserContentError } from "@sourceweft/builtin-document-parsers";
import type {
  ConnectorExtractedFileDescriptor,
  ConnectorItemSkipReason,
} from "./types";
import { isConnectorItemSkipError } from "./types";
import {
  classifySourceFile,
  type SourceFileKind,
} from "../sources/source-file-classifier";
import {
  DocumentNeedsOcrError,
  isDocumentProviderMimeType,
  startDocumentParse,
} from "../sources/parsers/providers/document-parse-orchestrator";
import { getSourceParser } from "../sources/parsers";
import { ContentError } from "../content/errors";
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

/** Fail closed: only these classifier kinds are resolvable by a connector sync.
 * Anything else — image, audio, transcript, or an unknown future kind — is
 * skipped before any download is attempted. */
const SUPPORTED_CLASSIFIER_KINDS = new Set<SourceFileKind>([
  "document",
  "text",
  "table",
  "json",
]);

/** The non-document branch admits only the plain-text and JSON parsers. The
 * shared registry also holds the OCR document provider, the paid-ASR audio
 * parser and the web-fetch parser; none of those may ever run on connector
 * bytes, so a lookup that returns one of them is treated as unsupported. */
const PLAIN_TEXT_PARSER_IDS = new Set(["text", "json"]);

function skipped(reason: ConnectorItemSkipReason): ResolvedExtractedFile {
  return { kind: "skipped", reason };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * The single place both parse branches classify a parse error. Returns a skip
 * reason for a deterministic, non-transient rejection (retrying the same bytes
 * could only fail the same way, so replaying the page would stall the
 * connector), or `null` for an error that should still throw and be retried on
 * the next run (I/O, 5xx, or unknown). Matches on class and code only — never
 * on message text, which may carry file-derived content.
 */
function classifyParseError(error: unknown): ConnectorItemSkipReason | null {
  if (error instanceof DocumentNeedsOcrError) return "needs_ocr";

  const code = errorCode(error);
  // Empty-content codes from the document parser must be checked before the
  // generic 4xx rule below (they are also 4xx ParserContentErrors).
  if (code === "ANYDOC_EMPTY_FILE" || code === "ANYDOC_NO_CONTENT") {
    return "empty_content";
  }
  if (code === "unsupported") return "unsupported_type";
  if (
    code === "malformed" ||
    code === "encrypted" ||
    code === "resourceLimit" ||
    code === "ANYDOC_FORMAT_MISMATCH"
  ) {
    return "unreadable";
  }

  // The text parser's binary-content rejection and any other deterministic 4xx
  // parser error: the bytes are structurally unusable, not a transient fault.
  if (error instanceof ParserContentError || error instanceof ContentError) {
    if (error.statusCode >= 400 && error.statusCode < 500) return "unreadable";
  }
  return null;
}

/**
 * Reduces a file-parse failure that still throws to a fixed message plus the
 * error code, keeping the original as `cause`. The code is a parser or anydoc
 * identifier, never file content, so no JSON.parse snippet or decoder text can
 * reach `itemFailures[].message` in run metadata.
 */
function sanitizedParseError(error: unknown): Error {
  const code = errorCode(error) ?? "unknown";
  return new Error(`Connector file parse failed (code: ${code})`, {
    cause: error,
  });
}

/** One place both parse branches route a thrown parse error through: a
 * deterministic rejection becomes a typed skip, anything else re-throws
 * sanitized for retry on the next run. */
function handleParseError(error: unknown): ResolvedExtractedFile {
  const reason = classifyParseError(error);
  if (reason) return skipped(reason);
  throw sanitizedParseError(error);
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
    !SUPPORTED_CLASSIFIER_KINDS.has(classification.kind)
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

  if (content.byteLength === 0) {
    // An empty download can never parse to content; the document parser throws
    // on it instead of returning, so skip it before any parsing is attempted.
    return skipped("empty_content");
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
    let outcome: Awaited<ReturnType<ExtractedFileDeps["parseDocument"]>>;
    try {
      outcome = await deps.parseDocument({
        ...parseInput,
        sourceId: "",
        ocr: "deny",
      });
    } catch (error) {
      return handleParseError(error);
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
    if (!parser || !PLAIN_TEXT_PARSER_IDS.has(parser.id)) {
      return skipped("unsupported_type");
    }

    let parsed: Awaited<ReturnType<typeof parser.parse>>;
    try {
      parsed = await parser.parse(parseInput);
    } catch (error) {
      return handleParseError(error);
    }
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
