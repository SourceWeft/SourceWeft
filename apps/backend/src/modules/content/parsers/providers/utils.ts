import type { ParsedDocument, ParsedPage, ParseInput } from "../types";
import type { SourceMetadata } from "../../types";
import { chunkSourceContent } from "../../chunker";

export const imageMimeTypes = [
  "image/avif",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/tiff",
  "image/bmp",
  "image/gif",
] as const;

export function isSupportedImageMimeType(mimeType: string) {
  return imageMimeTypes.includes(mimeType.toLowerCase() as (typeof imageMimeTypes)[number]);
}

export function normalizeWhitespace(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

export function toWordCount(value: string) {
  const matches = value.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

export async function buildParsedDocument(input: {
  parseInput: ParseInput;
  title?: string;
  content: string;
  pages?: ParsedPage[];
  metadata?: SourceMetadata;
}): Promise<ParsedDocument> {
  const content = normalizeWhitespace(input.content);
  const pages = input.pages?.length
    ? input.pages
        .map((page) => ({
          pageNumber: page.pageNumber,
          content: normalizeWhitespace(page.content),
        }))
        .filter((page) => page.content.length > 0)
    : content.length > 0
      ? [{ pageNumber: 1, content }]
      : [];
  const pageCount = input.metadata?.pageCount ?? pages.length;
  const chunks = await chunkSourceContent(content, input.parseInput.config);

  return {
    title: input.title ?? input.parseInput.fileName,
    content,
    metadata: {
      fileName: input.parseInput.fileName,
      fileSize: input.parseInput.fileSize,
      mimeType: input.parseInput.mimeType,
      pageCount,
      wordCount: toWordCount(content),
      charCount: content.length,
      extractedAt: new Date().toISOString(),
      ...(input.metadata ?? {}),
    },
    pages,
    chunks,
  };
}

export function summarizeNumbers(values: number[]) {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { min, max, avg };
}
