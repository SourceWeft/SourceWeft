export type VirtualFsSource = {
  sourceId: string;
  sourceType: "manual_upload" | "file_upload" | "web_url" | "youtube" | "note" | "artifact" | "connector" | "directory";
  parentSourceId: string | null;
  title: string;
  fileName: string | null;
  safeName: string;
  shortId: string;
  filePath: string | null;
  dirPath: string;
  readmePath: string | null;
  chunkCount: number;
  sizeBytes: number | null;
  mimeType: string | null;
  updatedAt: Date | string;
};

export type VirtualPathTarget =
  | { kind: "root" }
  | { kind: "kbRoot" }
  | { kind: "sourceFile"; sourceId: string }
  | { kind: "libraryDirectory"; sourceId: string }
  | { kind: "libraryDirectoryReadme"; sourceId: string }
  | { kind: "sourceChunksDir"; sourceId: string }
  | { kind: "chunkFile"; sourceId: string; chunkNo: number };

export type VirtualFsChunk = {
  sourceId: string;
  sourceTitle: string;
  sourceFileName: string | null;
  documentId: string;
  chunkId: string;
  chunkNo: number;
  content: string;
  startOffset: number | null;
  endOffset: number | null;
  headingPath: string | null;
  language: string | null;
};

export type VirtualFsDocument = {
  sourceId: string;
  sourceTitle: string;
  sourceFileName: string | null;
  documentId: string | null;
  content: string | null;
  updatedAt: Date | null;
};

export type VirtualFsGrepCandidate = VirtualFsChunk & {
  score: number;
};
