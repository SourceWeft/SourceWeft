import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { EPubLoader } from "@langchain/community/document_loaders/fs/epub";
import { PPTXLoader } from "@langchain/community/document_loaders/fs/pptx";
import { SRTLoader } from "@langchain/community/document_loaders/fs/srt";
import { JSONLinesLoader, JSONLoader } from "@langchain/classic/document_loaders/fs/json";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";

export function createDocxLoader(file: string | Blob, fileName?: string) {
  const lower = fileName?.toLowerCase() ?? "";
  return new DocxLoader(file, { type: lower.endsWith(".doc") ? "doc" : "docx" });
}

export function createCsvLoader(file: string | Blob) {
  return new CSVLoader(file);
}

export function createJsonLoader(file: string | Blob, mimeType?: string) {
  if (mimeType === "application/x-ndjson" || mimeType === "application/jsonl") {
    return new JSONLinesLoader(file, "/");
  }

  return new JSONLoader(file);
}

export function createTextLoader(file: string | Blob) {
  return new TextLoader(file);
}

export function createPptxLoader(file: string | Blob) {
  return new PPTXLoader(file);
}

export function createEpubLoader(file: string) {
  return new EPubLoader(file, { splitChapters: true });
}

export function createSrtLoader(file: string | Blob) {
  return new SRTLoader(file);
}
