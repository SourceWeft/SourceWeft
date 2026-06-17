import type { ParsedDocument, ParseInput, SourceMetadata } from "../types";
import type {
  DocumentParseProviderId,
  DocumentParseStrategy,
  ParsingConfig,
} from "../types";

export type ProviderPendingToken = {
  readonly backendId: DocumentParseProviderId;
  readonly taskId: string;
  readonly sourceId: string;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly parsingConfig: ParsingConfig;
  readonly attempt: number;
};

export type ProviderDiagnostics = {
  readonly metadata?: SourceMetadata;
};

export type ProviderParseOutcome =
  | {
      readonly kind: "completed";
      readonly document: ParsedDocument;
      readonly diagnostics?: ProviderDiagnostics;
    }
  | {
      readonly kind: "pending";
      readonly token: ProviderPendingToken;
      readonly diagnostics?: ProviderDiagnostics;
    };

export type ProviderParseInput = ParseInput & {
  readonly sourceId: string;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly userId: string;
};

export interface DocumentParseProvider {
  readonly id: DocumentParseProviderId;
  supports(mimeType: string): boolean;
  start(input: ProviderParseInput): Promise<ProviderParseOutcome>;
  resume?(
    token: ProviderPendingToken,
    content: Buffer,
  ): Promise<ProviderParseOutcome>;
}

export type PdfClassification =
  | {
      readonly kind: "pure_text";
      readonly confidence: number;
      readonly pageCount: number;
      readonly bitmapCoverage: readonly number[];
    }
  | {
      readonly kind: "non_pure_text";
      readonly confidence: number;
      readonly pageCount: number;
      readonly bitmapCoverage: readonly number[];
      readonly reason: "scan_like" | "hybrid" | "image_heavy" | "unknown";
    };

export type DocumentParseDecisionMetadataInput = {
  readonly outcome: ProviderParseOutcome;
  readonly strategy: DocumentParseStrategy;
  readonly requestedProvider: DocumentParseProviderId;
  readonly resolvedProvider: DocumentParseProviderId;
  readonly extraMetadata?: Record<string, unknown>;
};
