import type { ParsingConfig } from "../types";

export const DEFAULT_PARSER_VERSION = "v2-document-provider";
export const DEFAULT_CHUNK_SIZE = 512;

export function defaultParsingConfig(
  overrides?: Partial<ParsingConfig>,
): ParsingConfig {
  return {
    chunkSize: overrides?.chunkSize ?? DEFAULT_CHUNK_SIZE,
    parserVersion: overrides?.parserVersion ?? DEFAULT_PARSER_VERSION,
  };
}
