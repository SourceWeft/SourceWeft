import type { SourceParser } from "./types";
import { audioSourceParser } from "./audio";
import { csvSourceParser } from "./csv";
import { docxSourceParser } from "./docx";
import { documentProviderParser } from "./document-provider-parser";
import { epubSourceParser } from "./epub";
import { jsonSourceParser } from "./json";
import { pdfSourceParser } from "./pdf";
import { pptxSourceParser } from "./pptx";
import { srtSourceParser } from "./srt";
import { textSourceParser } from "./text";
import { webFetchSourceParser } from "./web-fetch";

const registeredParsers: SourceParser[] = [
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

export function getSourceParser(mimeType: string) {
  return registeredParsers.find((parser) =>
    parser.supportedMimeTypes.includes(mimeType),
  ) ?? null;
}

export function listSupportedSourceMimeTypes() {
  return registeredParsers.flatMap((parser) => parser.supportedMimeTypes);
}

export {
  audioSourceParser,
  csvSourceParser,
  docxSourceParser,
  documentProviderParser,
  epubSourceParser,
  pdfSourceParser,
  jsonSourceParser,
  pptxSourceParser,
  srtSourceParser,
  textSourceParser,
  webFetchSourceParser,
};
export type { ParsedDocument, ParseInput, ParsedPage, SourceParser } from "./types";
