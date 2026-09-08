export const builtinDocumentParsersCapability = {
  id: "sourceweft/document-parsers",
} as const;

export { builtinDocumentParsersCapabilityManifest } from "./manifest";
export { buildParsedDocument } from "./build-parsed-document";
export { chunkSourceContent } from "./chunker";
export { ParserContentError } from "./errors";
export { createDocumentProviderRegistry } from "./providers";
export { withTempFile } from "./file-buffer";
export { isSupportedImageMimeType, imageMimeTypes } from "./image-mime";
export { extractPdf2MarkdownResult } from "./pdf2markdown-result";
export { createJsonLoader, createTextLoader } from "./langchain-loaders";
export { createLoaderParser } from "./loader-parser";
export {
  createSourceParserRegistry,
  getPureSourceParser,
  listPureSupportedSourceMimeTypes,
  pureFileSourceParsers,
} from "./registry";
export {
  assertTextLikeSourceContent,
  normalizeWhitespace,
  toWordCount,
} from "./text-utils";
export { validatePublicHttpUrl } from "./web-url-safety";
export { WebFetchSourceParser, WEB_FETCH_SOURCE_MIME_TYPE } from "./web-fetch";
export { jsonSourceParser } from "./json";
export { srtSourceParser } from "./srt";
export { textSourceParser } from "./text";
export type {
  ChunkSpec,
  DocumentParseMode,
  DocumentParseProviderId,
  DocumentParseStrategy,
  ParsedDocument,
  ParsedPage,
  ParseInput,
  ParsingConfig,
  SourceMetadata,
  SourceParser,
  WebFetchProviderInput,
  WebFetchProviderLike,
  WebFetchProviderResult,
  WebFetchResultItem,
  WebProviderName,
} from "./types";

export {
  anydocMimeTypes,
  isAnydocMimeType,
  isAnydocNeedsOcrError,
  parseWithAnydoc,
} from "./anydoc";

export { anydocSourceParser } from "./anydoc";
export {
  anydocFormatCatalog,
  anydocExtensions,
  getAnydocFormatByExtension,
  getAnydocFormatByMimeType,
} from "./anydoc-formats";
export type { AnydocFormat, AnydocFormatDefinition } from "./anydoc-formats";
