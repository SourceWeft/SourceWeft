import type { ParsedDocument, ParseInput, SourceParser } from "./types";

export abstract class BaseSourceParser implements SourceParser {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly supportedMimeTypes: readonly string[];

  abstract parse(input: ParseInput): Promise<ParsedDocument>;

  protected normalizeWhitespace(value: string) {
    return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  }

  protected toWordCount(value: string) {
    const matches = value.trim().match(/\S+/g);
    return matches ? matches.length : 0;
  }
}
