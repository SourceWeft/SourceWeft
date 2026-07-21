import type {
  ParsedDocument as PackageParsedDocument,
  ParsedPage,
  ParseInput as PackageParseInput,
} from "@sourceweft/builtin-document-parsers";
import type { ContentBillingPort } from "../../content/billing-port";

/**
 * The package's parse input plus the one thing the backend adds: a billing
 * port. The widening is type-only — a package parser reads only the fields it
 * declares, so it accepts this input unchanged and no adapter is needed.
 */
export type ParseInput = PackageParseInput & {
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
