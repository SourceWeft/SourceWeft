import type { ParsedDocument, ParseInput } from "../types";
import type { DocumentParseProviderId, ParsingConfig, SourceMetadata } from "../../types";

export type ProviderPendingToken = {
  backendId: DocumentParseProviderId;
  taskId: string;
  sourceId: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  parsingConfig: ParsingConfig;
  attempt: number;
};

export type ProviderDiagnostics = {
  metadata?: SourceMetadata;
};

export type ProviderParseOutcome =
  | {
      kind: "completed";
      document: ParsedDocument;
      diagnostics?: ProviderDiagnostics;
    }
  | {
      kind: "pending";
      token: ProviderPendingToken;
      diagnostics?: ProviderDiagnostics;
    };

export type ProviderParseInput = ParseInput & {
  sourceId: string;
  teamId: string;
  workspaceId: string;
  userId: string;
};

export interface DocumentParseProvider {
  readonly id: DocumentParseProviderId;
  supports(mimeType: string): boolean;
  start(input: ProviderParseInput): Promise<ProviderParseOutcome>;
  resume?(token: ProviderPendingToken, content: Buffer): Promise<ProviderParseOutcome>;
}

export type PdfClassification =
  | {
      kind: "pure_text";
      confidence: number;
      pageCount: number;
      bitmapCoverage: number[];
    }
  | {
      kind: "non_pure_text";
      confidence: number;
      pageCount: number;
      bitmapCoverage: number[];
      reason: "scan_like" | "hybrid" | "image_heavy" | "unknown";
    };
