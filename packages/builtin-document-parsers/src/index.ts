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
export {
  createCsvLoader,
  createDocxLoader,
  createEpubLoader,
  createJsonLoader,
  createPptxLoader,
  createSrtLoader,
  createTextLoader,
} from "./langchain-loaders";
export { createLoaderParser } from "./loader-parser";
export { summarizeNumbers } from "./numbers";
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
export { csvSourceParser } from "./csv";
export { docxSourceParser } from "./docx";
export { epubSourceParser } from "./epub";
export { jsonSourceParser } from "./json";
export { pptxSourceParser } from "./pptx";
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
