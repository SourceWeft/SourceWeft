import { config } from "../../shared/config";
import type { ParsingConfig } from "../content/types";

export const DEFAULT_PARSER_VERSION =
  config.documentParsing.defaultParserVersion;
export const DEFAULT_CHUNK_SIZE = config.documentParsing.defaultChunkSize;

export function defaultParsingConfig(
  overrides?: Partial<ParsingConfig>,
): ParsingConfig {
  return {
    chunkSize: overrides?.chunkSize ?? DEFAULT_CHUNK_SIZE,
    parserVersion: overrides?.parserVersion ?? DEFAULT_PARSER_VERSION,
  };
}
