import { createDocumentProviderRegistry } from "@sourceweft/builtin-document-parsers/providers";
import { pdf2MarkdownProvider } from "./pdf2markdown-provider";

import { anydocProvider } from "./anydoc-provider";

const registry = createDocumentProviderRegistry({
  anydoc: anydocProvider,
  pdf2markdown: pdf2MarkdownProvider,
});

export const getDocumentProvider = registry.getDocumentProvider;
export const getDocumentProviderForResume =
  registry.getDocumentProviderForResume;
