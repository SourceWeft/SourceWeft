/**
 * Locates the passage of a cited chunk that supports the sentence a citation
 * marker follows.
 *
 * A message holds one citation row per chunk, so an anchor is a span inside
 * the chunk's original text, never a position in the answer. Offsets always
 * index the string the caller passes in (the stored chunk content), including
 * any markup it contains.
 */

export type CitationSupport = "strong" | "weak";

export type CitationAnchor = {
  support: CitationSupport;
  /** Share of the claim's weighted features found in the passage, 0..1. */
  score: number;
  startChar: number | null;
  endChar: number | null;
  quoteText: string | null;
};

/** Below this the claim carries too little signal to verify (e.g. "Yes"). */
const MIN_CLAIM_WEIGHT = 3;
const STRONG_SCORE = 0.5;
const MAX_SEGMENT_CHARS = 400;
const MAX_PAIR_CHARS = 600;
const PAIR_GAIN = 0.1;

const CANONICAL_MARKER = /\[citation:([\w:-]+)\]/g;
const ANY_CITATION_MARKER = /\[[^\]]*citation:[^\]]*\]/g;

const STOP_WORDS = new Set(
  (
    "the and for are was were with that this from have has had not but you your its " +
    "into than then they them their will would can could may might about over under " +
    "also been being such which while where when what who whom whose how all any each " +
    "more most some other out off per via"
  ).split(" "),
);
const CJK_STOP_CHARS = new Set([
  ..."的了是在和与及为有也就都而及其或并被把对于",
]);
const NUMBER_WORDS = new Map(
  Object.entries({
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  }),
);
const CJK_RUN = /[㐀-䶿一-鿿]+/g;

function isSentenceBoundary(text: string, index: number) {
  const ch = text[index];
  if (
    ch === "。" ||
    ch === "！" ||
    ch === "？" ||
    ch === "!" ||
    ch === "?" ||
    ch === "\n"
  ) {
    return true;
  }
  if (ch === ".") {
    const next = text[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

function lastSentence(region: string) {
  const trimmed = region.replace(/\s+$/, "");
  if (!trimmed) return "";
  let scanFrom = trimmed.length - 1;
  if (isSentenceBoundary(trimmed, scanFrom)) scanFrom -= 1;
  let start = 0;
  for (let index = scanFrom; index >= 0; index -= 1) {
    if (isSentenceBoundary(trimmed, index)) {
      start = index + 1;
      break;
    }
  }
  return trimmed
    .slice(start)
    .replace(ANY_CITATION_MARKER, " ")
    .replace(/^[\s，,；;:：、)\]]+/, "")
    .trim();
}

/** The sentence in front of every canonical marker, per citation key. */
export function extractCitedClaims(text: string) {
  const claims = new Map<string, string[]>();
  let previousEnd = 0;
  for (const match of text.matchAll(CANONICAL_MARKER)) {
    const markerStart = match.index ?? 0;
    const claim = lastSentence(text.slice(previousEnd, markerStart));
    previousEnd = markerStart + match[0].length;
    if (!claim) continue;
    const key = match[1]!;
    claims.set(key, [...(claims.get(key) ?? []), claim]);
  }
  return claims;
}

function featureWeights(raw: string) {
  const text = raw.replace(/<[^>]+>/g, " ").toLowerCase();
  const features = new Map<string, number>();
  const add = (feature: string, weight: number) => {
    if (!features.has(feature)) features.set(feature, weight);
  };

  for (const number of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    add(`n:${number[0].replace(/,/g, "")}`, 2);
  }
  for (const word of text.matchAll(/[a-z][a-z'-]+/g)) {
    const value = word[0];
    const spelledNumber = NUMBER_WORDS.get(value);
    if (spelledNumber !== undefined) {
      add(`n:${spelledNumber}`, 2);
    } else if (value.length >= 3 && !STOP_WORDS.has(value)) {
      add(`w:${value}`, 1);
    }
  }
  for (const run of text.matchAll(CJK_RUN)) {
    const chars = [...run[0]];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const first = chars[index]!;
      const second = chars[index + 1]!;
      if (CJK_STOP_CHARS.has(first) || CJK_STOP_CHARS.has(second)) continue;
      add(`c:${first}${second}`, 1);
    }
  }
  return features;
}

type Segment = { start: number; end: number };

function pushSegment(
  segments: Segment[],
  content: string,
  start: number,
  end: number,
) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(content[from]!)) from += 1;
  while (to > from && /\s/.test(content[to - 1]!)) to -= 1;
  if (from >= to) return;
  while (to - from > MAX_SEGMENT_CHARS) {
    let cut = from + MAX_SEGMENT_CHARS;
    const soft = content.slice(from, cut).search(/[，,；;、\s][^，,；;、\s]*$/);
    if (soft > MAX_SEGMENT_CHARS / 2) cut = from + soft + 1;
    segments.push({ start: from, end: cut });
    from = cut;
    while (from < to && /\s/.test(content[from]!)) from += 1;
  }
  if (from < to) segments.push({ start: from, end: to });
}

function segmentContent(content: string) {
  const segments: Segment[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (isSentenceBoundary(content, index)) {
      pushSegment(segments, content, start, index + 1);
      start = index + 1;
    }
  }
  pushSegment(segments, content, start, content.length);
  return segments;
}

function weighted(features: Map<string, number>) {
  let total = 0;
  for (const weight of features.values()) total += weight;
  return total;
}

/** Best supporting passage of `content` for one claim. */
export function anchorClaimInContent(input: {
  claim: string;
  content: string;
}): CitationAnchor | null {
  const claim = featureWeights(input.claim);
  const claimWeight = weighted(claim);
  if (claimWeight < MIN_CLAIM_WEIGHT || !input.content) {
    return {
      support: "weak",
      score: 0,
      startChar: null,
      endChar: null,
      quoteText: null,
    };
  }

  const segments = segmentContent(input.content);
  const scoreOf = (start: number, end: number) => {
    const window = featureWeights(input.content.slice(start, end));
    let hit = 0;
    for (const [feature, weight] of claim) {
      if (window.has(feature)) hit += weight;
    }
    return hit / claimWeight;
  };
  // A passage that shares the claim's words but not its figures is a
  // contradiction or an invention, not support.
  const missesAFigure = (start: number, end: number) => {
    const window = featureWeights(input.content.slice(start, end));
    for (const feature of claim.keys()) {
      if (feature.startsWith("n:") && !window.has(feature)) return true;
    }
    return false;
  };

  let best: { start: number; end: number; score: number } | null = null;
  for (const segment of segments) {
    const score = scoreOf(segment.start, segment.end);
    if (!best || score > best.score) best = { ...segment, score };
  }
  if (best) {
    for (let index = 0; index + 1 < segments.length; index += 1) {
      const first = segments[index]!;
      const second = segments[index + 1]!;
      if (second.end - first.start > MAX_PAIR_CHARS) continue;
      const score = scoreOf(first.start, second.end);
      if (score >= best.score + PAIR_GAIN) {
        best = { start: first.start, end: second.end, score };
      }
    }
  }

  if (
    !best ||
    best.score < STRONG_SCORE ||
    missesAFigure(best.start, best.end)
  ) {
    return {
      support: "weak",
      score: best?.score ?? 0,
      startChar: null,
      endChar: null,
      quoteText: null,
    };
  }
  return {
    support: "strong",
    score: best.score,
    startChar: best.start,
    endChar: best.end,
    quoteText: input.content.slice(best.start, best.end),
  };
}

export type AnchorableCitation = {
  citation: string;
  chunkId: string;
  externalUri?: string;
  fileReference?: unknown;
  content?: string;
};

/**
 * Anchors every citation the final answer actually uses. Source chunks load
 * their original content on demand; external and file citations use the
 * content stored with them. A citation whose content is unavailable gets no
 * entry, so the caller keeps its existing excerpt untouched.
 */
export async function anchorCitations(input: {
  text: string;
  citations: readonly AnchorableCitation[];
  loadChunkContents: (chunkIds: string[]) => Promise<Map<string, string>>;
}) {
  const claims = extractCitedClaims(input.text);
  const used = input.citations.filter((citation) =>
    claims.has(citation.citation),
  );

  const needsLoad = used.filter(
    (citation) =>
      !citation.content && !citation.externalUri && !citation.fileReference,
  );
  const loaded = needsLoad.length
    ? await input.loadChunkContents([
        ...new Set(needsLoad.map((citation) => citation.chunkId)),
      ])
    : new Map<string, string>();

  const anchors = new Map<string, CitationAnchor>();
  for (const citation of used) {
    const content = citation.content || loaded.get(citation.chunkId);
    if (!content) continue;
    let best: CitationAnchor | null = null;
    for (const claim of claims.get(citation.citation) ?? []) {
      const anchor = anchorClaimInContent({ claim, content });
      if (!anchor) continue;
      const better =
        !best ||
        (anchor.support === "strong" && best.support === "weak") ||
        (anchor.support === best.support && anchor.score > best.score);
      if (better) best = anchor;
    }
    if (best) anchors.set(citation.citation, best);
  }
  return anchors;
}
