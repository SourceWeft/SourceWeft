import { anydocFormatCatalog } from "@sourceweft/builtin-document-parsers/formats";
import {
  assertTextLikeSourceContent,
  ParserContentError,
} from "@sourceweft/builtin-document-parsers";
import {
  classifySourceFile,
  CONNECTOR_FILE_KINDS,
  getSourceFileExtension,
  isConnectorIndexableFile,
  listSupportedSourceFileExtensions,
} from "@sourceweft/builtin-document-parsers/file-types";
import type {
  SourceFileClassification,
  SourceFileKind,
  UnsupportedSourceFileClassification,
} from "@sourceweft/builtin-document-parsers/file-types";
import { ContentError } from "../content/errors";

export type {
  SourceFileClassification,
  SourceFileKind,
  UnsupportedSourceFileClassification,
};
export {
  classifySourceFile,
  CONNECTOR_FILE_KINDS,
  getSourceFileExtension,
  isConnectorIndexableFile,
  listSupportedSourceFileExtensions,
};

export function requireSupportedSourceFile(input: {
  fileName: string;
  mimeType?: string | null;
}) {
  const classification = classifySourceFile(input);
  if (classification.supported) {
    return classification;
  }

  throw new ContentError(
    400,
    "UNSUPPORTED_SOURCE_TYPE",
    `${classification.reason}. Supported formats include ${anydocFormatCatalog.map((entry) => entry.extensions.join("/")).join(", ")}, common text/code files, JSON, SRT, images, and DeepInfra ASR audio formats (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm).`,
  );
}

export function assertSourceContentCanBeParsed(input: {
  classification: SourceFileClassification;
  content: Buffer;
  fileName: string;
}) {
  if (
    !["text", "table", "json", "transcript"].includes(input.classification.kind)
  ) {
    return;
  }

  // The binary-content check is the parser package's, so upload-time rejection
  // and parse-time rejection cannot disagree. This is an upload path rather
  // than a parse, so the parser's error is translated here — the translation in
  // `parsers/text.ts` only covers calls made through the parser itself.
  try {
    assertTextLikeSourceContent(input.content, input.fileName);
  } catch (error) {
    if (error instanceof ParserContentError) {
      throw new ContentError(error.statusCode, error.code, error.message);
    }
    throw error;
  }
}
