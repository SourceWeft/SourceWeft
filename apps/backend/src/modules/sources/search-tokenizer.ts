const MAX_TOKEN_CHARS = 128;
const MAX_PART_CHARS = 4096;
const MAX_PART_TOKENS = 256;

type SegmenterLike = {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};

const cjkCharPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const cjkRunPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const latinNumberRunPattern = /[\p{Script=Latin}\p{Number}][\p{Script=Latin}\p{Number}_./:-]*/gu;
const tokenPattern = /[\p{Letter}\p{Number}]+/gu;
const separatorPattern = /[_./:-]+/u;

const segmenter: SegmenterLike | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("und", { granularity: "word" })
    : null;

export function buildSearchParts(content: string): string[] {
  return packTokens(extractSearchTokens(content, { includeCjkUnigrams: true }));
}

export function buildSearchQuery(query: string): string {
  const normalized = normalizeText(query);
  const includeCjkUnigrams = countCjkChars(normalized) <= 1;
  return extractSearchTokens(normalized, { includeCjkUnigrams }).join(" ");
}

function extractSearchTokens(
  input: string,
  options: { includeCjkUnigrams: boolean },
) {
  const normalized = normalizeText(input);
  if (!normalized) {
    return [];
  }

  const tokens: string[] = [];
  addStructuredTokens(tokens, normalized);

  for (const segment of segmentWords(normalized)) {
    addToken(tokens, segment);
    addStructuredTokens(tokens, segment);
  }

  addCjkTokens(tokens, normalized, options);

  return dedupe(tokens);
}

function normalizeText(input: string) {
  return input.normalize("NFKC").trim();
}

function segmentWords(input: string) {
  if (segmenter) {
    return Array.from(segmenter.segment(input))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  }

  return Array.from(input.matchAll(tokenPattern), (match) => match[0]);
}

function addStructuredTokens(tokens: string[], segment: string) {
  for (const match of segment.matchAll(latinNumberRunPattern)) {
    const value = match[0];
    addToken(tokens, value);

    for (const part of value.split(separatorPattern)) {
      addToken(tokens, part);
      for (const camelPart of splitCamelCase(part)) {
        addToken(tokens, camelPart);
      }
    }
  }
}

function addCjkTokens(
  tokens: string[],
  input: string,
  options: { includeCjkUnigrams: boolean },
) {
  for (const match of input.matchAll(cjkRunPattern)) {
    const chars = Array.from(match[0]);
    if (chars.length === 1) {
      addToken(tokens, chars[0]);
      continue;
    }

    for (let index = 0; index < chars.length - 1; index += 1) {
      addToken(tokens, `${chars[index]}${chars[index + 1]}`);
    }

    if (options.includeCjkUnigrams) {
      for (const char of chars) {
        addToken(tokens, char);
      }
    }
  }
}

function splitCamelCase(input: string) {
  return input
    .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/\s+/u);
}

function addToken(tokens: string[], rawToken: string | undefined) {
  const token = rawToken?.trim().toLowerCase();
  if (!token || token.length > MAX_TOKEN_CHARS) {
    return;
  }
  if (!/[\p{Letter}\p{Number}]/u.test(token) && !cjkCharPattern.test(token)) {
    return;
  }
  tokens.push(token);
}

function dedupe(tokens: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

function packTokens(tokens: string[]) {
  const parts: string[] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const token of tokens) {
    const nextChars = currentChars + token.length + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0 &&
      (current.length >= MAX_PART_TOKENS || nextChars > MAX_PART_CHARS)
    ) {
      parts.push(current.join(" "));
      current = [];
      currentChars = 0;
    }

    current.push(token);
    currentChars += token.length + (current.length > 1 ? 1 : 0);
  }

  if (current.length > 0) {
    parts.push(current.join(" "));
  }

  return parts;
}

function countCjkChars(input: string) {
  let count = 0;
  for (const char of input) {
    if (cjkCharPattern.test(char)) {
      count += 1;
    }
  }
  return count;
}
