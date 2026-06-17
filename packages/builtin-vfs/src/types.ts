export type VirtualFsSource = {
  readonly sourceId: string;
  readonly sourceType:
    | "manual_upload"
    | "file_upload"
    | "web_url"
    | "youtube"
    | "note"
    | "artifact"
    | "connector"
    | "directory";
  readonly parentSourceId: string | null;
  readonly title: string;
  readonly fileName: string | null;
  readonly safeName: string;
  readonly shortId: string;
  readonly filePath: string | null;
  readonly dirPath: string;
  readonly readmePath: string | null;
  readonly chunkCount: number;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
  readonly updatedAt: Date | string;
};

export type VirtualPathTarget =
  | { readonly kind: "root" }
  | { readonly kind: "kbRoot" }
  | { readonly kind: "sourceFile"; readonly sourceId: string }
  | { readonly kind: "libraryDirectory"; readonly sourceId: string }
  | { readonly kind: "libraryDirectoryReadme"; readonly sourceId: string }
  | { readonly kind: "sourceChunksDir"; readonly sourceId: string }
  | {
      readonly kind: "chunkFile";
      readonly sourceId: string;
      readonly chunkNo: number;
    };

export type VirtualFsChunk = {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly sourceFileName: string | null;
  readonly documentId: string;
  readonly chunkId: string;
  readonly chunkNo: number;
  readonly content: string;
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly headingPath: string | null;
  readonly language: string | null;
};

export type VirtualFsDocument = {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly sourceFileName: string | null;
  readonly documentId: string | null;
  readonly content: string | null;
  readonly updatedAt: Date | null;
};

export type VirtualFsGrepCandidate = VirtualFsChunk & {
  readonly score: number;
};
