import { TextDecoder } from "node:util";
import { chunkSourceContent } from "./chunker";
import { ParserContentError } from "./errors";
import {
  assertTextLikeSourceContent,
  normalizeWhitespace,
  toWordCount,
} from "./text-utils";
import type {
  ParsedDocument,
  ParsedPage,
  ParseInput,
  SourceParser,
} from "./types";

/**
 * JSON is indexed as one `path.to.key: value` line per leaf.
 *
 * Every key and every scalar (string, number, boolean, null) reaches the index,
 * and each line carries its full key path. The chunker splits on size, so a
 * chunk taken from the middle of a large document still says which key each
 * value belongs to; indented JSON would leave such a chunk with values under
 * parent keys that were cut off in an earlier chunk, and with braces and
 * quotes that only cost tokens.
 *
 * JSON Lines / NDJSON keep one page per non-empty line; the paths of each
 * line start at that line's own root.
 */

const utf8Decoder = new TextDecoder("utf-8");

const JSON_LINES_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/jsonl",
  "application/x-ndjson",
]);

/**
 * A number kept as the text it was written with, so that integers beyond
 * 2^53 (IDs in API responses) and forms such as `1.50` or `1e3` are indexed
 * exactly as they appear in the file instead of as a rounded double.
 */
class JsonNumberLiteral {
  constructor(readonly source: string) {}
}

type JsonReviver = (
  key: string,
  value: unknown,
  context?: { readonly source?: string },
) => unknown;

const keepNumberSource: JsonReviver = (_key, value, context) =>
  typeof value === "number" && typeof context?.source === "string"
    ? new JsonNumberLiteral(context.source)
    : value;

function parseJsonValue(text: string, describeLocation: () => string) {
  try {
    return JSON.parse(
      text,
      keepNumberSource as Parameters<typeof JSON.parse>[1],
    ) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // The SyntaxError message can quote file content; keep it out of the
      // error, which ends up in source status and connector run metadata.
      throw new ParserContentError(
        400,
        "JSON_INVALID",
        `${describeLocation()} is not valid JSON`,
      );
    }
    if (error instanceof RangeError) {
      // The reviver walks the parsed value recursively, so nesting thousands
      // of levels deep overflows the stack. The same bytes always fail the
      // same way, so this is a content rejection, not a retryable fault.
      throw new ParserContentError(
        400,
        "JSON_TOO_DEEP",
        `${describeLocation()} is nested too deeply to index`,
      );
    }
    throw error;
  }
}

const BARE_KEY = /^[^\s.[\]"'`:]+$/u;

function appendKey(path: string, key: string) {
  if (BARE_KEY.test(key)) {
    return path.length > 0 ? `${path}.${key}` : key;
  }
  return `${path}[${JSON.stringify(key)}]`;
}

function formatScalar(value: unknown) {
  if (value instanceof JsonNumberLiteral) return value.source;
  if (typeof value === "string") return value;
  return String(value);
}

function writeLine(lines: string[], path: string, value: string) {
  lines.push(path.length > 0 ? `${path}: ${value}` : value);
}

/** Flattens a parsed JSON value into `path: value` lines, depth-first. */
export function flattenJsonToLines(root: unknown): string[] {
  const lines: string[] = [];
  // An explicit stack instead of recursion: deeply nested input must not
  // exhaust the call stack.
  const stack: Array<{ readonly path: string; readonly value: unknown }> = [
    { path: "", value: root },
  ];

  while (stack.length > 0) {
    const { path, value } = stack.pop()!;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        writeLine(lines, path, "[]");
        continue;
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ path: `${path}[${index}]`, value: value[index] });
      }
      continue;
    }

    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof JsonNumberLiteral)
    ) {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        writeLine(lines, path, "{}");
        continue;
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        stack.push({ path: appendKey(path, key), value: child });
      }
      continue;
    }

    writeLine(lines, path, formatScalar(value));
  }

  return lines;
}

function toPageContent(value: unknown) {
  return normalizeWhitespace(flattenJsonToLines(value).join("\n"));
}

function parseJsonPages(text: string, fileName: string): ParsedPage[] {
  const content = toPageContent(
    parseJsonValue(text, () => `File '${fileName}'`),
  );
  return content.length > 0 ? [{ pageNumber: 1, content }] : [];
}

function parseJsonLinesPages(text: string, fileName: string): ParsedPage[] {
  const pages: ParsedPage[] = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const content = toPageContent(
      parseJsonValue(line, () => `Line ${index + 1} of '${fileName}'`),
    );
    if (content.length > 0) {
      pages.push({ pageNumber: pages.length + 1, content });
    }
  }
  return pages;
}

class JsonSourceParser implements SourceParser {
  readonly id = "json";
  readonly name = "JSON Parser";
  readonly supportedMimeTypes = [
    "application/json",
    "application/jsonl",
    "application/x-ndjson",
  ] as const;

  async parse(input: ParseInput): Promise<ParsedDocument> {
    assertTextLikeSourceContent(input.content, input.fileName);
    // TextDecoder drops a leading UTF-8 BOM, which JSON.parse would reject.
    const text = utf8Decoder.decode(input.content);
    const pages = JSON_LINES_MIME_TYPES.has(input.mimeType)
      ? parseJsonLinesPages(text, input.fileName)
      : parseJsonPages(text, input.fileName);
    const content = pages.map((page) => page.content).join("\n\n");
    const chunks = await chunkSourceContent(content, input.config);
    return {
      title: input.fileName,
      content,
      metadata: {
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        pageCount: pages.length,
        wordCount: toWordCount(content),
        charCount: content.length,
        extractedAt: new Date().toISOString(),
      },
      pages,
      chunks,
    };
  }
}

export const jsonSourceParser: SourceParser = new JsonSourceParser();
