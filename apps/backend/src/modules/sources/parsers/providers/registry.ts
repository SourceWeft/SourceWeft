import { createDocumentProviderRegistry } from "@sourceweft/builtin-document-parsers/providers";
import { langChainPdfProvider } from "./langchain-pdf-provider";
import { pdf2MarkdownProvider } from "./pdf2markdown-provider";

const registry = createDocumentProviderRegistry({
  langchain: langChainPdfProvider,
  pdf2markdown: pdf2MarkdownProvider,
});

export const getDocumentProvider = registry.getDocumentProvider;
export const getDocumentProviderForResume =
  registry.getDocumentProviderForResume;
