import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { ChunkSpec, ParsingConfig } from "./types";

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 150;
const MIN_CHUNK_SIZE = 200;

type ChunkRange = {
  startIndex: number;
  endIndex: number;
};

function getChunkSize(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  return config?.chunkSize ?? DEFAULT_CHUNK_SIZE;
}

function createTextSplitter(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  const chunkSize = getChunkSize(config);
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: Math.min(DEFAULT_CHUNK_OVERLAP, Math.max(0, chunkSize - 1)),
  });
}

function estimateTokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function locateChunk(input: {
  content: string;
  chunkText: string;
  searchStart: number;
}) {
  let startIndex = input.content.indexOf(input.chunkText, input.searchStart);
  if (startIndex < 0) {
    startIndex = input.content.indexOf(input.chunkText);
  }
  if (startIndex < 0) {
    startIndex = input.searchStart;
  }

  return {
    startIndex,
    endIndex: startIndex + input.chunkText.length,
  };
}

function toChunk(input: {
  text: string;
  startIndex: number;
  endIndex: number;
}): ChunkSpec {
  return {
    text: input.text,
    startIndex: input.startIndex,
    endIndex: input.endIndex,
    tokenCount: estimateTokenCount(input.text),
  };
}

function toRanges(content: string, splitTexts: string[]) {
  const ranges: ChunkRange[] = [];
  let searchStart = 0;

  for (const text of splitTexts) {
    if (text.trim().length === 0) {
      continue;
    }

    const range = locateChunk({
      content,
      chunkText: text,
      searchStart,
    });
    ranges.push(range);
    searchStart = Math.max(
      range.startIndex + 1,
      range.endIndex - DEFAULT_CHUNK_OVERLAP,
    );
  }

  return ranges;
}

function mergeShortChunks(content: string, ranges: ChunkRange[]) {
  if (ranges.length <= 1) {
    return ranges;
  }

  const pending = ranges.map((range) => ({ ...range }));
  const merged: ChunkRange[] = [];

  for (let index = 0; index < pending.length; index += 1) {
    const range = pending[index];
    if (!range) {
      continue;
    }

    const length = content.slice(range.startIndex, range.endIndex).trim().length;
    const next = pending[index + 1];
    const previous = merged[merged.length - 1];

    if (length >= MIN_CHUNK_SIZE) {
      merged.push({ ...range });
      continue;
    }

    if (next) {
      next.startIndex = Math.min(next.startIndex, range.startIndex);
      continue;
    }

    if (previous) {
      previous.endIndex = Math.max(previous.endIndex, range.endIndex);
      continue;
    }

    merged.push({ ...range });
  }

  return merged;
}

export async function chunkSourceContent(
  contentText: string,
  config?: Pick<ParsingConfig, "chunkSize"> | null,
) {
  const normalized = contentText.trim();
  if (!normalized) {
    return [];
  }

  const splitter = createTextSplitter(config);
  const splitTexts = await splitter.splitText(normalized);
  const ranges = mergeShortChunks(normalized, toRanges(normalized, splitTexts));

  return ranges.map((range) =>
    toChunk({
      text: normalized.slice(range.startIndex, range.endIndex),
      startIndex: range.startIndex,
      endIndex: range.endIndex,
    }),
  );
}
