import { getAnydocFormatByMimeType } from "@sourceweft/builtin-document-parsers/formats";
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
import { getDocumentProvider } from "./registry";
import { isSupportedImageMimeType } from "./utils";
import { tryParseImageWithVision } from "./image-vision-provider";

type ImageVisionParser = typeof tryParseImageWithVision;

let imageVisionParser: ImageVisionParser = tryParseImageWithVision;

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
  return isSupportedImageMimeType(mimeType) || isAnydocMimeType(mimeType);
}

export async function startDocumentParse(
  input: ProviderParseInput,
): Promise<ProviderParseOutcome> {
  const canonicalMimeType =
    getAnydocFormatByMimeType(input.mimeType)?.mimeType ?? input.mimeType;
  const canonicalInput =
    canonicalMimeType === input.mimeType
      ? input
      : { ...input, mimeType: canonicalMimeType };
  const outcome = await startCanonicalDocumentParse(canonicalInput);
  if (canonicalMimeType === input.mimeType) return outcome;
  const provenance = {
    documentParseInputMimeType: input.mimeType,
    documentParseCanonicalMimeType: canonicalMimeType,
  };
  return {
    ...outcome,
    ...(outcome.kind === "completed"
      ? {
          document: {
            ...outcome.document,
            metadata: { ...outcome.document.metadata, ...provenance },
          },
        }
      : {}),
    diagnostics: {
      metadata: { ...outcome.diagnostics?.metadata, ...provenance },
    },
  };
}

async function startCanonicalDocumentParse(
  input: ProviderParseInput,
): Promise<ProviderParseOutcome> {
  const strategy = "explicit";
  const requestedProvider = "anydoc";

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

export const testExports = {
  setImageVisionParserForTest(parser: ImageVisionParser) {
    imageVisionParser = parser;
    return () => {
      imageVisionParser = tryParseImageWithVision;
    };
  },
};
