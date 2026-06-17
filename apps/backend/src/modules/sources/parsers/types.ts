import type {
  ParsedDocument as PackageParsedDocument,
  ParsedPage,
  ParseInput as PackageParseInput,
  SourceParser as PackageSourceParser,
} from "@sourceweft/builtin-document-parsers";
import type { ContentBillingPort } from "../../content/billing-port";

export type ParseInput = Omit<PackageParseInput, "billing"> & {
  readonly billing?: ContentBillingPort;
};

/** Derives from the canonical package type to guarantee structural compatibility. */
export type ParsedDocument = PackageParsedDocument;

/** Backend-specific parser interface that accepts {@link ParseInput} (with billing port). */
export interface SourceParser {
  readonly id: string;
  readonly name: string;
  readonly supportedMimeTypes: readonly string[];
  parse(input: ParseInput): Promise<ParsedDocument>;
}

export type { ParsedPage };

export function toBackendParsedDocument(
  document: PackageParsedDocument,
): ParsedDocument {
  return {
    title: document.title,
    content: document.content,
    metadata: document.metadata,
    pages: document.pages,
    chunks: document.chunks.map((chunk) => ({
      text: chunk.text,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      tokenCount: chunk.tokenCount,
      ...(chunk.embedding ? { embedding: [...chunk.embedding] } : {}),
    })),
  };
}

export function toBackendSourceParser(
  parser: PackageSourceParser,
): SourceParser {
  return {
    id: parser.id,
    name: parser.name,
    supportedMimeTypes: parser.supportedMimeTypes,
    async parse(input: ParseInput) {
      return toBackendParsedDocument(await parser.parse(input));
    },
  };
}
