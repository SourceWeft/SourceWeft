import type { ParsedDocument, ParseInput, SourceParser } from "./types";
import { normalizeWhitespace, toWordCount } from "./text-utils";

export { normalizeWhitespace, toWordCount } from "./text-utils";

export abstract class BaseSourceParser implements SourceParser {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly supportedMimeTypes: readonly string[];

  abstract parse(input: ParseInput): Promise<ParsedDocument>;

  protected normalizeWhitespace(value: string) {
    return normalizeWhitespace(value);
  }

  protected toWordCount(value: string) {
    return toWordCount(value);
  }
}
