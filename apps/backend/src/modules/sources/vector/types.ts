export type RetrievalCandidate = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  sourceTitle: string;
  chunkNo: number;
  content: string;
  score: number;
  stage: "vector";
};
