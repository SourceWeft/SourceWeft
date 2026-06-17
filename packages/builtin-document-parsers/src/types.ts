export type ParsingConfig = {
  readonly chunkSize: number;
  readonly parserVersion: string;
};

export type DocumentParseProviderId =
  | "langchain"
  | "pdf2markdown"
  | "vision"
  | "docling"
  | "llamaparse"
  | "unstructured";

export type DocumentParseStrategy =
  | "explicit"
  | "balanced"
  | "cost"
  | "quality";

export type DocumentParseMode =
  | "pure_text_pdf"
  | "ocr_pdf"
  | "image_ocr"
  | "image_vision"
  | "generic";

export type ChunkSpec = {
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly tokenCount: number;
  readonly embedding?: readonly number[];
};

export type SourceMetadata = {
  readonly fileName?: string;
  readonly fileSize?: number;
  readonly mimeType?: string;
  readonly pageCount?: number;
  readonly wordCount?: number;
  readonly charCount?: number;
  readonly extractedAt?: string;
  readonly uploadMethod?: "manual" | "api";
  readonly documentParseStrategy?: DocumentParseStrategy;
  readonly documentParseProvider?: DocumentParseProviderId;
  readonly documentParseBackend?: DocumentParseProviderId;
  readonly documentParseProviderRequested?: DocumentParseProviderId;
  readonly documentParseProviderResolved?: DocumentParseProviderId;
  readonly documentParseMode?: DocumentParseMode;
  readonly providerTaskId?: string;
  readonly providerStatus?: string;
  readonly providerAttempts?: number;
  readonly providerUpdatedAt?: string;
  readonly pdfClassification?: "pure_text" | "non_pure_text";
  readonly pdfClassificationConfidence?: number;
  readonly pdfBitmapCoverageSummary?: {
    readonly min: number;
    readonly max: number;
    readonly avg: number;
  };
  readonly [key: string]: unknown;
};

export type ParseInput = {
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly content: Buffer;
  readonly config: ParsingConfig;
  readonly sourceExternalUri?: string;
  readonly forceRefresh?: boolean;
  readonly preferInputTitle?: boolean;
  readonly sourceId?: string;
  readonly sourceRevisionId?: string;
  readonly teamId?: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly idempotencyKey?: string;
};

export type ParsedPage = {
  readonly pageNumber: number;
  readonly content: string;
};

export type ParsedDocument = {
  readonly title: string;
  readonly content: string;
  readonly metadata: SourceMetadata;
  readonly pages: readonly ParsedPage[];
  readonly chunks: readonly ChunkSpec[];
};

export interface SourceParser {
  readonly id: string;
  readonly name: string;
  readonly supportedMimeTypes: readonly string[];
  parse(input: ParseInput): Promise<ParsedDocument>;
}

export type WebProviderName = "anycrawl" | string;

export type WebFetchProviderInput = {
  readonly fresh?: boolean;
  readonly items: readonly {
    readonly url: string;
    readonly prompt?: string;
  }[];
};

export type WebFetchResultItem = {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly markdown: string;
  readonly wordCount: number;
  readonly truncated: boolean;
  readonly error?: string;
};

export type WebFetchProviderResult = {
  readonly provider: WebProviderName;
  readonly count: number;
  readonly results: readonly WebFetchResultItem[];
};

export type WebFetchProviderLike = {
  readonly name: WebProviderName;
  fetch(input: WebFetchProviderInput): Promise<WebFetchProviderResult>;
};
