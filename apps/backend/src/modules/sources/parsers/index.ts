import { createSourceParserRegistry } from "@sourceweft/builtin-document-parsers";
import { audioSourceParser } from "./audio";
import { csvSourceParser } from "./csv";
import { documentProviderParser } from "./document-provider-parser";
import { docxSourceParser } from "./docx";
import { epubSourceParser } from "./epub";
import { jsonSourceParser } from "./json";
import { pdfSourceParser } from "./pdf";
import { pptxSourceParser } from "./pptx";
import { srtSourceParser } from "./srt";
import { textSourceParser } from "./text";
import type { SourceParser } from "./types";
import { webFetchSourceParser } from "./web-fetch";

const sourceParsers: readonly SourceParser[] = [
  documentProviderParser,
  audioSourceParser,
  docxSourceParser,
  epubSourceParser,
  csvSourceParser,
  jsonSourceParser,
  pptxSourceParser,
  srtSourceParser,
  textSourceParser,
  webFetchSourceParser,
];

const parserRegistry = createSourceParserRegistry(sourceParsers);

export const getSourceParser = parserRegistry.getSourceParser;
export const listSupportedSourceMimeTypes =
  parserRegistry.listSupportedSourceMimeTypes;

export {
  audioSourceParser,
  csvSourceParser,
  docxSourceParser,
  documentProviderParser,
  epubSourceParser,
  jsonSourceParser,
  pdfSourceParser,
  pptxSourceParser,
  srtSourceParser,
  textSourceParser,
  webFetchSourceParser,
};
export { toBackendParsedDocument } from "./types";
export type {
  ParsedDocument,
  ParsedPage,
  ParseInput,
  SourceParser,
} from "./types";
