import { config } from "../../../shared/config";
import {
  createSourceParserRegistry,
  csvSourceParser,
  docxSourceParser,
  epubSourceParser,
  jsonSourceParser,
  pptxSourceParser,
  srtSourceParser,
} from "@sourceweft/builtin-document-parsers";
import { audioSourceParser } from "./audio";
import { documentProviderParser } from "./document-provider-parser";
import { pdfSourceParser } from "./pdf";
import { textSourceParser } from "./text";
import type { SourceParser } from "./types";
import { webFetchSourceParser } from "./web-fetch";

const sourceParsers: readonly SourceParser[] = [
  documentProviderParser,
  audioSourceParser,
  ...(config.documentParsing.provider === "anydoc"
    ? []
    : [docxSourceParser, epubSourceParser, csvSourceParser, pptxSourceParser]),
  jsonSourceParser,
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
export type {
  ParsedDocument,
  ParsedPage,
  ParseInput,
  SourceParser,
} from "./types";
