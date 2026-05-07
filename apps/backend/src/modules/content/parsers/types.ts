import type { ChunkSpec, ParsingConfig, SourceMetadata } from "../types";

export type ParseInput = {
  fileName: string;
  mimeType: string;
  fileSize: number;
  content: Buffer;
  config: ParsingConfig;
  sourceExternalUri?: string;
  forceRefresh?: boolean;
  preferInputTitle?: boolean;
  sourceId?: string;
  sourceRevisionId?: string;
  teamId?: string;
  workspaceId?: string;
  userId?: string;
  idempotencyKey?: string;
};

export type ParsedPage = {
  pageNumber: number;
  content: string;
};

export type ParsedDocument = {
  title: string;
  content: string;
  metadata: SourceMetadata;
  pages: ParsedPage[];
  chunks: ChunkSpec[];
};

export interface SourceParser {
  readonly id: string;
  readonly name: string;
  readonly supportedMimeTypes: readonly string[];
  parse(input: ParseInput): Promise<ParsedDocument>;
}
