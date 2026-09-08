import type { ProviderParseInput as PackageProviderParseInput } from "@sourceweft/builtin-document-parsers/providers";
import type { ContentBillingPort } from "../../../content/billing-port";

export type {
  DocumentParseProvider,
  ProviderDiagnostics,
  ProviderParseOutcome,
  ProviderPendingToken,
} from "@sourceweft/builtin-document-parsers/providers";

/**
 * Backend view of the package's provider input, carrying the billing port that
 * already flows through at runtime (parsing-service builds it into `parseInput`
 * and spreads it into `startDocumentParse`). Mirrors the same widening done for
 * {@link ../types.ParseInput} rather than pushing a backend-only dependency
 * into the parsers package.
 *
 * Optional because {@link ../document-provider-parser.DocumentProviderParser}
 * adapts a plain `ParseInput`, whose billing port is itself optional. Providers
 * that need to bill must therefore assert its presence, not assume it.
 */
export type ProviderParseInput = PackageProviderParseInput & {
  readonly billing?: ContentBillingPort;
};
