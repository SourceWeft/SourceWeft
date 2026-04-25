import type { DocumentParseProvider } from "./types";
import type { DocumentParseProviderId } from "../../types";
import { langChainPdfProvider } from "./langchain-pdf-provider";
import { pdf2MarkdownProvider } from "./pdf2markdown-provider";

const providers: Record<string, DocumentParseProvider> = {
  langchain: langChainPdfProvider,
  pdf2markdown: pdf2MarkdownProvider,
};

export function getDocumentProvider(id: DocumentParseProviderId) {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Document parse provider is not implemented: ${id}`);
  }

  return provider;
}

export function getDocumentProviderForResume(id: DocumentParseProviderId) {
  const provider = getDocumentProvider(id);
  if (!provider.resume) {
    throw new Error(`Document parse provider does not support async resume: ${id}`);
  }

  return provider as DocumentParseProvider & {
    resume: NonNullable<DocumentParseProvider["resume"]>;
  };
}
