import type { DocumentParseProvider } from "./types";
import type { DocumentParseProviderId } from "../types";

type ResumableDocumentParseProvider = DocumentParseProvider & {
  readonly resume: NonNullable<DocumentParseProvider["resume"]>;
};

function hasResume(
  provider: DocumentParseProvider,
): provider is ResumableDocumentParseProvider {
  return typeof provider.resume === "function";
}

export function createDocumentProviderRegistry(
  providers: Readonly<Record<string, DocumentParseProvider>>,
) {
  function getDocumentProvider(id: DocumentParseProviderId) {
    const provider = providers[id];
    if (!provider) {
      throw new Error(`Document parse provider is not implemented: ${id}`);
    }
    return provider;
  }

  function getDocumentProviderForResume(id: DocumentParseProviderId) {
    const provider = getDocumentProvider(id);
    if (!hasResume(provider)) {
      throw new Error(
        `Document parse provider does not support async resume: ${id}`,
      );
    }
    return provider;
  }

  return { getDocumentProvider, getDocumentProviderForResume };
}
