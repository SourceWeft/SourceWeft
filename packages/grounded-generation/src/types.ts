import type { GroundedCorpusChunk } from "@sourceweft/contracts/grounded-generation";

/** A chunk as the host loads it. */
export type CorpusChunkInput = GroundedCorpusChunk;

/** A chunk inside the prompt, addressed by its short `handle` ("c12"). */
export type CorpusChunk = GroundedCorpusChunk & {
  handle: string;
  tokens: number;
};
