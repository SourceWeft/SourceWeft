import { createDocumentProviderRegistry } from "@sourceweft/builtin-document-parsers/providers";
import { pdf2MarkdownProvider } from "./pdf2markdown-provider";

import { config } from "../../../../shared/config";
import { anydocProvider } from "./anydoc-provider";
import { createDeepSeekOcrProvider } from "./deepseek-ocr-provider";

const registry = createDocumentProviderRegistry({
  anydoc: anydocProvider,
  pdf2markdown: pdf2MarkdownProvider,
  deepseek: createDeepSeekOcrProvider({
    apiKey: () => config.documentParsing.deepseekOcr.apiKey,
  }),
});

export const getDocumentProvider = registry.getDocumentProvider;
export const getDocumentProviderForResume =
  registry.getDocumentProviderForResume;
