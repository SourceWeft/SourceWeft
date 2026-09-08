import { anydocSourceParser } from "./anydoc";
import { jsonSourceParser } from "./json";
import { srtSourceParser } from "./srt";
import { textSourceParser } from "./text";
import type { SourceParser } from "./types";

export function createSourceParserRegistry<TParser extends SourceParser>(
  parsers: readonly TParser[],
) {
  const registeredParsers = [...parsers];
  return {
    getSourceParser(mimeType: string) {
      return (
        registeredParsers.find((parser) =>
          parser.supportedMimeTypes.includes(mimeType),
        ) ?? null
      );
    },
    listSupportedSourceMimeTypes() {
      return registeredParsers.flatMap((parser) => parser.supportedMimeTypes);
    },
  };
}

export const pureFileSourceParsers: readonly SourceParser[] = [
  anydocSourceParser,
  jsonSourceParser,
  srtSourceParser,
  textSourceParser,
] as const;

const pureRegistry = createSourceParserRegistry(pureFileSourceParsers);

export const getPureSourceParser = pureRegistry.getSourceParser;
export const listPureSupportedSourceMimeTypes =
  pureRegistry.listSupportedSourceMimeTypes;
