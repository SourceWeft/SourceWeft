/**
 * The citable passages of an MCP overview's input (#152): the registry
 * description, the README excerpt and the tool and variable descriptions,
 * cut into short passages and numbered in place, so a category's evidence is
 * a passage ID the model picks rather than text it has to copy exactly.
 *
 * Text is cut into paragraphs at blank lines; within one, a list item,
 * heading, blockquote or table row starts a new item and other lines are the
 * item's wrapped prose; items are cut into sentences. Fenced code is never
 * numbered. A passage too short to be evidence is left unnumbered.
 *
 * Pure. The texts given are already quoted as the prompt shows them
 * (./prompt.ts), so a passage's text is exactly what the model sees after
 * its ID.
 */

// Evidence quotations, in characters after whitespace is collapsed: a
// shorter passage is never numbered.
export const MCP_OVERVIEW_EVIDENCE_MIN_CHARS = 8;
// The most passages one prompt numbers (and so the most IDs its schema's enum
// lists).
export const MCP_OVERVIEW_MAX_PASSAGES = 500;

export type McpOverviewPassage = { id: string; text: string };

/** Where a passage is in its text: `text.slice(start, end)`. */
export type PassageSpan = { start: number; end: number };

/** Sentences, or whole items (list items, paragraphs, rows). */
export type PassageLevel = "sentence" | "item";

/**
 * The texts that are numbered, as the prompt quotes them. Tools and
 * variables are in the order the prompt lists them (environment variables,
 * then headers); an entry is null when it has no description.
 */
export type McpOverviewPassageSources = {
  description: string | null;
  readme: string | null;
  tools: Array<string | null>;
  variables: Array<string | null>;
};

/** Each text with its passage IDs in place, and every passage by ID. */
export type NumberedMcpOverviewSources = McpOverviewPassageSources & {
  // The description's, then the README's, the tools' and the variables'.
  passages: McpOverviewPassage[];
};

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

/**
 * Numbers the passages of every source in place: `[D1]` and on in the
 * description, `[R1]` and on across the README excerpt, `[T{n}.{k}]` in the
 * n-th tool's description and `[V{n}.{k}]` in the n-th variable's, where n is
 * the tool's or variable's position in the prompt (from 1).
 *
 * At most `maxPassages` are numbered. Over that, the README is numbered by
 * whole items instead of sentences; still over, the description, tools and
 * variables are numbered first, in that order, and the README's items get
 * what is left, in document order. What is not numbered is shown unchanged.
 */
export function numberMcpOverviewPassages(
  sources: McpOverviewPassageSources,
  maxPassages = MCP_OVERVIEW_MAX_PASSAGES,
): NumberedMcpOverviewSources {
  const others = [
    { prefix: "D", text: sources.description },
    ...sources.tools.map((text, index) => ({ prefix: `T${index + 1}.`, text })),
    ...sources.variables.map((text, index) => ({
      prefix: `V${index + 1}.`,
      text,
    })),
  ].map((source) => ({
    ...source,
    spans: source.text ? findPassages(source.text, "sentence") : [],
  }));
  const readme = sources.readme;
  let readmeSpans = readme ? findPassages(readme, "sentence") : [];
  const othersCount = others.reduce(
    (count, source) => count + source.spans.length,
    0,
  );
  if (readme && othersCount + readmeSpans.length > maxPassages) {
    readmeSpans = findPassages(readme, "item");
  }
  let budget = maxPassages;
  for (const source of others) {
    source.spans = source.spans.slice(0, Math.max(0, budget));
    budget -= source.spans.length;
  }
  readmeSpans = readmeSpans.slice(0, Math.max(0, budget));

  const passages: McpOverviewPassage[] = [];
  const number = (
    text: string | null,
    prefix: string,
    spans: PassageSpan[],
  ): string | null => {
    if (text === null) return null;
    let rendered = "";
    let at = 0;
    spans.forEach((span, index) => {
      const id = `${prefix}${index + 1}`;
      passages.push({ id, text: text.slice(span.start, span.end) });
      rendered += `${text.slice(at, span.start)}[${id}] `;
      at = span.start;
    });
    return rendered + text.slice(at);
  };
  const [description, ...rest] = others;
  const numberedDescription = number(
    description!.text,
    description!.prefix,
    description!.spans,
  );
  const numberedReadme = number(readme, "R", readmeSpans);
  const numberedRest = rest.map((source) =>
    number(source.text, source.prefix, source.spans),
  );
  return {
    description: numberedDescription,
    readme: numberedReadme,
    tools: numberedRest.slice(0, sources.tools.length),
    variables: numberedRest.slice(sources.tools.length),
    passages,
  };
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

// A fence opens with three or more backticks or tildes (indented or not) and
// closes with a run of the same character at least as long, alone on its
// line — the rules ./input.ts reads README fences by.
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
// A line that starts an item: a list item, heading, blockquote or table row.
const ITEM_START_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|#{1,6})(?:[ \t]|$)|[>|])/;
// Items that are one line: a heading or a table row has no wrapped prose.
const ONE_LINE_ITEM_RE = /^[ \t]*(?:#{1,6}(?:[ \t]|$)|\|)/;
// The markers before an item's text, nested ones included ("> - ").
const LEAD_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|#{1,6})[ \t]+|[>|][ \t]*)*/;
// A sentence ends at one of . ! ? 。 ！ ？ followed by whitespace.
const SENTENCE_END_RE = /[.!?。！？](\s+)/g;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/**
 * The citable passages of `text`, in order: its sentences, or its whole
 * items. A passage starts after its item's markers and never crosses a blank
 * line or a fence.
 */
export function findPassages(text: string, level: PassageLevel): PassageSpan[] {
  const out: PassageSpan[] = [];
  for (const item of findItems(text)) {
    const start =
      item.start + LEAD_RE.exec(text.slice(item.start, item.end))![0].length;
    const spans =
      level === "item"
        ? [{ start, end: item.end }]
        : sentences(text, { start, end: item.end });
    for (const span of spans) {
      const trimmed = trimSpan(text, span);
      if (trimmed && isCitable(text.slice(trimmed.start, trimmed.end))) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

/** Items outside fenced code: runs of lines, as spans of `text`. */
function findItems(text: string): PassageSpan[] {
  const items: PassageSpan[] = [];
  // The item the next plain line would continue; null after a blank line,
  // a fence, or a heading or table row.
  let open: PassageSpan | null = null;
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const opening = FENCE_OPEN_RE.exec(line);
    // "```x`" is inline code, not a fence.
    if (
      opening &&
      !(opening[1]!.startsWith("`") && opening[2]!.includes("`"))
    ) {
      fence = { char: opening[1]![0]!, length: opening[1]!.length };
      open = null;
      continue;
    }
    if (!line.trim()) {
      open = null;
      continue;
    }
    if (open && !ITEM_START_RE.test(line)) {
      open.end = end;
      continue;
    }
    const item = { start, end };
    items.push(item);
    open = ONE_LINE_ITEM_RE.test(line) ? null : item;
  }
  return items;
}

/** An item's text cut after each sentence end that whitespace follows. */
function sentences(text: string, item: PassageSpan): PassageSpan[] {
  const body = text.slice(0, item.end);
  const out: PassageSpan[] = [];
  let start = item.start;
  SENTENCE_END_RE.lastIndex = item.start;
  for (
    let match = SENTENCE_END_RE.exec(body);
    match;
    match = SENTENCE_END_RE.exec(body)
  ) {
    const end = match.index + 1;
    out.push({ start, end });
    start = end + match[1]!.length;
  }
  if (start < item.end) out.push({ start, end: item.end });
  return out;
}

/** The span without surrounding whitespace; null when nothing is left. */
function trimSpan(text: string, span: PassageSpan): PassageSpan | null {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return end > start ? { start, end } : null;
}

/**
 * Long enough to be evidence, measured the way the parser (./prompt.ts)
 * measures evidence — whitespace collapsed, and again once quotation marks,
 * emphasis and code markers are set aside — and with a word to cite. A
 * numbered passage is never refused as too short.
 */
function isCitable(text: string): boolean {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return (
    Array.from(collapsed).length >= MCP_OVERVIEW_EVIDENCE_MIN_CHARS &&
    Array.from(evidenceKey(collapsed)).length >=
      MCP_OVERVIEW_EVIDENCE_MIN_CHARS &&
    LETTER_OR_DIGIT_RE.test(collapsed)
  );
}

/**
 * Text as evidence is compared: Unicode-normalized, lowercased, whitespace
 * collapsed, typographic quotes and dashes made plain, emphasis and code
 * markers dropped, and surrounding quotation marks or ellipses trimmed.
 */
export function evidenceKey(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/^["'.\s]+|["'.\s]+$/g, "");
}
