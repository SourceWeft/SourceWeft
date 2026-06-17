import { chunkSourceContent } from "./chunker";
import { normalizeWhitespace, toWordCount } from "./text-utils";
import type {
  ParsedDocument,
  ParsedPage,
  ParseInput,
  SourceMetadata,
} from "./types";

export async function buildParsedDocument(input: {
  readonly parseInput: ParseInput;
  readonly title?: string;
  readonly content: string;
  readonly pages?: readonly ParsedPage[];
  readonly metadata?: SourceMetadata;
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
