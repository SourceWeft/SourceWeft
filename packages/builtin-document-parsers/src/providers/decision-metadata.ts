import type {
  DocumentParseDecisionMetadataInput,
  ProviderParseOutcome,
} from "./types";

export function withDecisionMetadata(
  input: DocumentParseDecisionMetadataInput,
): ProviderParseOutcome {
  return {
    ...input.outcome,
    diagnostics: {
      metadata: {
        ...(input.outcome.diagnostics?.metadata ?? {}),
        documentParseStrategy: input.strategy,
        documentParseProviderRequested: input.requestedProvider,
        documentParseProviderResolved: input.resolvedProvider,
        documentParseProvider: input.resolvedProvider,
        documentParseBackend: input.resolvedProvider,
        ...(input.extraMetadata ?? {}),
      },
    },
  };
}
