import {
  isAnydocNeedsOcrError,
  isAnydocMimeType,
} from "@sourceweft/builtin-document-parsers";
import { config } from "../../../../shared/config";
import type {
  DocumentParseProviderId,
  DocumentParseStrategy,
} from "../../../content/types";
import type { ProviderParseInput, ProviderParseOutcome } from "./types";
import { classifyPdf } from "./pdf-classifier";
import { langChainPdfProvider } from "./langchain-pdf-provider";
import { getDocumentProvider } from "./registry";
import { isSupportedImageMimeType, summarizeNumbers } from "./utils";
import { tryParseImageWithVision } from "./image-vision-provider";

type ImageVisionParser = typeof tryParseImageWithVision;

let imageVisionParser: ImageVisionParser = tryParseImageWithVision;

function getConfiguredStrategy() {
  return config.documentParsing.strategy as DocumentParseStrategy;
}

function getConfiguredProviderId() {
  return config.documentParsing.provider as DocumentParseProviderId;
}

function ensureSupported(
  providerId: DocumentParseProviderId,
  mimeType: string,
) {
  const provider = getDocumentProvider(providerId);
  if (!provider.supports(mimeType)) {
    throw new Error(
      `Document parse provider '${providerId}' does not support MIME type: ${mimeType}`,
    );
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
  const metadata = {
    ...(input.outcome.diagnostics?.metadata ?? {}),
    documentParseStrategy: input.strategy,
    documentParseProviderRequested: input.requestedProvider,
    documentParseProviderResolved: input.resolvedProvider,
    documentParseProvider: input.resolvedProvider,
    documentParseBackend: input.resolvedProvider,
    ...(input.extraMetadata ?? {}),
  };
  if (input.outcome.kind === "completed") {
    return {
      ...input.outcome,
      document: {
        ...input.outcome.document,
        metadata: { ...input.outcome.document.metadata, ...metadata },
      },
      diagnostics: { metadata },
    };
  }
  return { ...input.outcome, diagnostics: { metadata } };
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

async function startConfiguredOcr(
  input: ProviderParseInput,
  strategy: DocumentParseStrategy,
  requestedProvider: DocumentParseProviderId,
  reason: "needsOcr" | "image_strategy",
): Promise<ProviderParseOutcome> {
  if (!config.documentParsing.ocrEnabled) {
    throw new Error(
      "Document requires OCR, but DOCUMENT_PARSE_OCR_ENABLED is false",
    );
  }
  return startWithProvider({
    providerId: config.documentParsing.ocrProvider,
    parseInput: input,
    strategy,
    requestedProvider,
    extraMetadata: {
      ...(reason === "needsOcr" ? { documentParseEntryEngine: "anydoc" } : {}),
      documentParseOcrReason: reason,
    },
  });
}

export function isDocumentProviderMimeType(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    isSupportedImageMimeType(mimeType) ||
    (getConfiguredProviderId() === "anydoc" && isAnydocMimeType(mimeType))
  );
}

export async function startDocumentParse(
  input: ProviderParseInput,
): Promise<ProviderParseOutcome> {
  const strategy = getConfiguredStrategy();
  const requestedProvider = getConfiguredProviderId();

  if (isSupportedImageMimeType(input.mimeType)) {
    if (config.documentParsing.imageStrategy === "ocr") {
      return startConfiguredOcr(
        input,
        strategy,
        requestedProvider,
        "image_strategy",
      );
    }
    const visionOutcome = await imageVisionParser(input);
    if (visionOutcome.kind !== "completed") {
      throw new Error(
        `Configured image vision parsing failed: ${visionOutcome.reason}`,
      );
    }
    return withDecisionMetadata({
      outcome: visionOutcome.outcome,
      strategy,
      requestedProvider,
      resolvedProvider: "vision",
    });
  }

  if (requestedProvider === "anydoc") {
    const provider = ensureSupported("anydoc", input.mimeType);
    let outcome: ProviderParseOutcome;
    try {
      outcome = await provider.start(input);
    } catch (error) {
      // OCR is a declared branch, never a catch-all replacement parser.
      if (!isAnydocNeedsOcrError(error)) throw error;
      return startConfiguredOcr(input, strategy, requestedProvider, "needsOcr");
    }
    return withDecisionMetadata({
      outcome,
      strategy,
      requestedProvider,
      resolvedProvider: "anydoc",
      extraMetadata: { documentParseEntryEngine: "anydoc" },
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

  // Classification errors and local parser errors must fail without silently
  // routing a document to a different (possibly remote) implementation.
  const classification = await classifyPdf(input.content);
  const metadata = {
    pdfClassification: classification.kind,
    pdfClassificationConfidence: classification.confidence,
    pdfBitmapCoverageSummary: summarizeNumbers(classification.bitmapCoverage),
  };
  if (classification.kind === "pure_text") {
    const outcome = await langChainPdfProvider.start(input);
    return withDecisionMetadata({
      outcome,
      strategy,
      requestedProvider,
      resolvedProvider: "langchain",
      extraMetadata: metadata,
    });
  }
  return startWithProvider({
    providerId: requestedProvider,
    parseInput: input,
    strategy,
    requestedProvider,
    extraMetadata: metadata,
  });
}

export const testExports = {
  setImageVisionParserForTest(parser: ImageVisionParser) {
    imageVisionParser = parser;
    return () => {
      imageVisionParser = tryParseImageWithVision;
    };
  },
};
