import { config } from "../../../../shared/config";
import type { DocumentParseProviderId, DocumentParseStrategy } from "../../types";
import type { ProviderParseInput, ProviderParseOutcome } from "./types";
import { classifyPdf } from "./pdf-classifier";
import { langChainPdfProvider } from "./langchain-pdf-provider";
import { getDocumentProvider } from "./registry";
import { isSupportedImageMimeType, summarizeNumbers } from "./utils";
import { tryParseImageWithVision } from "./image-vision-provider";

type ImageVisionParser = typeof tryParseImageWithVision;

let imageVisionParser: ImageVisionParser = tryParseImageWithVision;

const providerIds = new Set<DocumentParseProviderId>([
  "langchain",
  "pdf2markdown",
  "docling",
  "llamaparse",
  "unstructured",
]);

const strategies = new Set<DocumentParseStrategy>([
  "explicit",
  "balanced",
  "cost",
  "quality",
]);

function parseProviderId(value: string | undefined) {
  const normalized = value?.trim().toLowerCase() as DocumentParseProviderId | undefined;
  return normalized && providerIds.has(normalized) ? normalized : null;
}

function parseStrategy(value: string | undefined) {
  const normalized = value?.trim().toLowerCase() as DocumentParseStrategy | undefined;
  return normalized && strategies.has(normalized) ? normalized : null;
}

function getConfiguredStrategy() {
  return parseStrategy(process.env.DOCUMENT_PARSE_STRATEGY) ??
    (config.documentParsing.strategy as DocumentParseStrategy);
}

function getConfiguredProviderId() {
  return parseProviderId(process.env.DOCUMENT_PARSE_PROVIDER) ??
    (config.documentParsing.provider as DocumentParseProviderId);
}

function ensureSupported(providerId: DocumentParseProviderId, mimeType: string) {
  const provider = getDocumentProvider(providerId);
  if (!provider.supports(mimeType)) {
    throw new Error(`Document parse provider '${providerId}' does not support MIME type: ${mimeType}`);
  }

  return provider;
}

function withDecisionMetadata(input: {
  outcome: ProviderParseOutcome;
  strategy: DocumentParseStrategy;
  requestedProvider: DocumentParseProviderId;
  resolvedProvider: DocumentParseProviderId;
  extraMetadata?: Record<string, unknown>;
}): ProviderParseOutcome {
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

async function startWithProvider(input: {
  providerId: DocumentParseProviderId;
  parseInput: ProviderParseInput;
  strategy: DocumentParseStrategy;
  requestedProvider: DocumentParseProviderId;
  extraMetadata?: Record<string, unknown>;
}) {
  const provider = ensureSupported(input.providerId, input.parseInput.mimeType);
  const outcome = await provider.start(input.parseInput);

  return withDecisionMetadata({
    outcome,
    strategy: input.strategy,
    requestedProvider: input.requestedProvider,
    resolvedProvider: input.providerId,
    extraMetadata: input.extraMetadata,
  });
}

export async function startDocumentParse(
  input: ProviderParseInput,
): Promise<ProviderParseOutcome> {
  const strategy = getConfiguredStrategy();
  const requestedProvider = getConfiguredProviderId();

  if (isSupportedImageMimeType(input.mimeType)) {
    const visionOutcome = await imageVisionParser(input);
    if (visionOutcome.kind === "completed") {
      return withDecisionMetadata({
        outcome: visionOutcome.outcome,
        strategy,
        requestedProvider,
        resolvedProvider: "vision",
      });
    }

    return startWithProvider({
      providerId: "pdf2markdown",
      parseInput: input,
      strategy,
      requestedProvider,
      extraMetadata: {
        ...(requestedProvider === "pdf2markdown"
          ? {}
          : { documentParseProviderFallbackReason: "image_requires_ocr" }),
        visionFallbackReason: visionOutcome.reason,
        pageCount: 1,
      },
    });
  }

  if (strategy === "explicit") {
    return startWithProvider({
      providerId: requestedProvider,
      parseInput: input,
      strategy,
      requestedProvider,
    });
  }

  if (strategy === "quality") {
    return startWithProvider({
      providerId: requestedProvider,
      parseInput: input,
      strategy,
      requestedProvider,
    });
  }

  if (input.mimeType !== "application/pdf") {
    return startWithProvider({
      providerId: requestedProvider,
      parseInput: input,
      strategy,
      requestedProvider,
    });
  }

  try {
    const classification = await classifyPdf(input.content);
    const summary = summarizeNumbers(classification.bitmapCoverage);

    if (classification.kind === "pure_text") {
      const outcome = await langChainPdfProvider.start(input);
      return withDecisionMetadata({
        outcome,
        strategy,
        requestedProvider,
        resolvedProvider: "langchain",
        extraMetadata: {
          pdfClassification: classification.kind,
          pdfClassificationConfidence: classification.confidence,
          pdfBitmapCoverageSummary: summary,
        },
      });
    }

    return startWithProvider({
      providerId: requestedProvider,
      parseInput: input,
      strategy,
      requestedProvider,
      extraMetadata: {
        pdfClassification: classification.kind,
        pdfClassificationConfidence: classification.confidence,
        pdfBitmapCoverageSummary: summary,
      },
    });
  } catch (error) {
    return startWithProvider({
      providerId: requestedProvider,
      parseInput: input,
      strategy,
      requestedProvider,
      extraMetadata: {
        pdfClassification: "non_pure_text",
        pdfClassificationConfidence: 0,
        pdfClassificationError: error instanceof Error ? error.message : "PDF classification failed",
      },
    });
  }
}

export const testExports = {
  setImageVisionParserForTest(parser: ImageVisionParser) {
    imageVisionParser = parser;
    return () => {
      imageVisionParser = tryParseImageWithVision;
    };
  },
};
