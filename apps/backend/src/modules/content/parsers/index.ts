import type { SourceParser } from "./types";
import { csvSourceParser } from "./csv";
import { docxSourceParser } from "./docx";
import { documentProviderParser } from "./document-provider-parser";
import { epubSourceParser } from "./epub";
import { jsonSourceParser } from "./json";
import { pdfSourceParser } from "./pdf";
import { pptxSourceParser } from "./pptx";
import { srtSourceParser } from "./srt";
import { textSourceParser } from "./text";

const registeredParsers: SourceParser[] = [
  documentProviderParser,
  docxSourceParser,
  epubSourceParser,
  csvSourceParser,
  jsonSourceParser,
  pptxSourceParser,
  srtSourceParser,
  textSourceParser,
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
  csvSourceParser,
  docxSourceParser,
  documentProviderParser,
  epubSourceParser,
  pdfSourceParser,
  jsonSourceParser,
  pptxSourceParser,
  srtSourceParser,
  textSourceParser,
};
export type { ParsedDocument, ParseInput, ParsedPage, SourceParser } from "./types";
