export type VirtualFsSource = {
  sourceId: string;
  title: string;
  fileName: string | null;
  safeName: string;
  shortId: string;
  filePath: string;
  dirPath: string;
  chunkCount: number;
  sizeBytes: number | null;
  mimeType: string | null;
  updatedAt: Date | string;
};

export type VirtualPathTarget =
  | { kind: "root" }
  | { kind: "kbRoot" }
  | { kind: "sourceFile"; sourceId: string }
  | { kind: "sourceDir"; sourceId: string }
  | { kind: "chunksDir"; sourceId: string }
  | { kind: "chunkFile"; sourceId: string; chunkNo: number };

export type VirtualFsChunk = {
  sourceId: string;
  sourceTitle: string;
  sourceFileName: string | null;
  documentId: string;
  chunkId: string;
  chunkNo: number;
  content: string;
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
