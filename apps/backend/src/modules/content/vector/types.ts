export type RetrievalCandidate = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  stage: "vector";
};
