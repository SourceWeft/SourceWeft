import type { ParsedDocument, ParseInput, SourceMetadata } from "../types";
import type { DocumentParseProviderId, ParsingConfig } from "../types";

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
