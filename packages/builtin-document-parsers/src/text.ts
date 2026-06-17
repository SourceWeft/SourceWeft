import { TextDecoder } from "node:util";
import { BaseSourceParser } from "./base";
import { chunkSourceContent } from "./chunker";
import { assertTextLikeSourceContent } from "./text-utils";
import type { ParsedDocument, ParseInput, SourceParser } from "./types";

const utf8Decoder = new TextDecoder("utf-8");

class TextSourceParser extends BaseSourceParser {
  readonly id = "text";
  readonly name = "Text Parser";
  readonly supportedMimeTypes = [
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "text/html",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
    "image/svg+xml",
    "text/css",
    "text/javascript",
    "application/javascript",
    "application/typescript",
    "application/x-typescript",
    "application/yaml",
    "application/x-yaml",
    "text/yaml",
    "application/toml",
    "text/tab-separated-values",
  ] as const;

  async parse(input: ParseInput): Promise<ParsedDocument> {
    assertTextLikeSourceContent(input.content, input.fileName);
    const content = this.normalizeWhitespace(utf8Decoder.decode(input.content));
    const chunks = await chunkSourceContent(content, input.config);
    const pages = content.length > 0 ? [{ pageNumber: 1, content }] : [];
    return {
      title: input.fileName,
      content,
      metadata: {
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        pageCount: pages.length,
        wordCount: this.toWordCount(content),
        charCount: content.length,
        extractedAt: new Date().toISOString(),
      },
      pages,
      chunks,
    };
  }
}

export const textSourceParser: SourceParser = new TextSourceParser();
