import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { ChunkSpec, ParsingConfig } from "./types";

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 150;
const MIN_CHUNK_SIZE = 200;
const HTML_TAG_DENSITY_THRESHOLD = 0.12;
const HTML_TAG_COUNT_THRESHOLD = 8;
const HTML_EXTRA_SEPARATORS = [
  "<tbody",
  "<thead",
  "<tfoot",
  "<a",
  "<img",
  "<center",
  "<form",
  "<input",
  "<b",
];

type ChunkRange = {
  startIndex: number;
  endIndex: number;
};

function getChunkSize(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  return config?.chunkSize ?? DEFAULT_CHUNK_SIZE;
}

function getChunkOverlap(chunkSize: number) {
  return Math.min(DEFAULT_CHUNK_OVERLAP, Math.max(0, chunkSize - 1));
}

function createTextSplitter(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  const chunkSize = getChunkSize(config);
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: getChunkOverlap(chunkSize),
  });
}

function createHtmlTextSplitter(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  const chunkSize = getChunkSize(config);
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: getChunkOverlap(chunkSize),
    separators: createHtmlSeparators(),
  });
}

function createSourceTextSplitter(
  content: string,
  config?: Pick<ParsingConfig, "chunkSize"> | null,
) {
  return isLikelyHtml(content)
    ? createHtmlTextSplitter(config)
    : createTextSplitter(config);
}

function createHtmlSeparators() {
  const baseSeparators = RecursiveCharacterTextSplitter.getSeparatorsForLanguage("html");
  const separators = baseSeparators.map((separator) =>
    /^<[a-z][a-z0-9]*>$/i.test(separator) ? separator.slice(0, -1) : separator,
  );
  const tailSeparators = separators.filter((separator) => separator === " " || separator === "");
  const tagSeparators = separators.filter((separator) => separator !== " " && separator !== "");

  return Array.from(
    new Set([...tagSeparators, ...HTML_EXTRA_SEPARATORS, ...tailSeparators]),
  );
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

function isLikelyHtml(content: string) {
  const tagMatches = content.match(/<\/?[a-z][^>]*>/gi) ?? [];
  if (tagMatches.length === 0) {
    return false;
  }

  const tagLength = tagMatches.reduce((sum, tag) => sum + tag.length, 0);
  return (
    /<!doctype\s+html\b|<html\b|<body\b|<table\b|<tr\b/i.test(content) ||
    tagMatches.length >= HTML_TAG_COUNT_THRESHOLD ||
    tagLength / Math.max(content.length, 1) >= HTML_TAG_DENSITY_THRESHOLD
  );
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

  const splitter = createSourceTextSplitter(normalized, config);
  const splitTexts = await splitter.splitText(normalized);
  const ranges = mergeShortChunks(
    normalized,
    toRanges(normalized, splitTexts),
  );

  return ranges.map((range) =>
    toChunk({
      text: normalized.slice(range.startIndex, range.endIndex),
      startIndex: range.startIndex,
      endIndex: range.endIndex,
    }),
  );
}
