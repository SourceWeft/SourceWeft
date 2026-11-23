import { toObjectRecord } from "../../../shared/records";

/** One cited source, reduced to what a footnote shows. */
export type ExportCitation = {
  citation: string;
  sourceTitle: string | null;
  externalUri: string | null;
  quote: string | null;
};

const MAX_QUOTE_CHARS = 200;

/** Same marker grammar the chat renders (web `message-response.tsx`). */
const CITATION_PATTERN =
  /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/g;

/** Fenced blocks (closed or running to the end) and inline code spans. */
export const CODE_PATTERN =
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toExportCitation(value: unknown): ExportCitation | null {
  const record = toObjectRecord(value);
  const citation = nonEmptyString(record?.citation);
  if (!record || !citation) {
    return null;
  }
  const span =
    record.support === "strong" ? nonEmptyString(record.spanText) : null;
  return {
    citation,
    sourceTitle: nonEmptyString(record.sourceTitle),
    externalUri: nonEmptyString(record.externalUri),
    quote: span ?? nonEmptyString(record.excerpt),
  };
}

/**
 * The citation records stored on an assistant message: the ones the answer
 * used, or every offered one when the run did not record which were used.
 */
export function readCitationRecords(
  metadata: Record<string, unknown>,
): ExportCitation[] {
  const retrieval = toObjectRecord(metadata.retrieval);
  const used = Array.isArray(retrieval?.citations) ? retrieval.citations : [];
  const offered = Array.isArray(retrieval?.availableCitations)
    ? retrieval.availableCitations
    : [];
  const raw = used.length > 0 ? used : offered;
  return raw
    .map(toExportCitation)
    .filter((record): record is ExportCitation => record !== null);
}

/**
 * Numbers footnotes across a whole document: the first marker for a citation
 * id takes the next number and later markers for the same id reuse it.
 */
export function createFootnotes() {
  const numbers = new Map<string, number>();

  function replaceInText(
    text: string,
    byId: Map<string, ExportCitation>,
    added: Array<{ n: number; record: ExportCitation }>,
  ) {
    return text.replace(CITATION_PATTERN, (_marker, ids: string) =>
      ids
        .split(",")
        .map((id) => id.trim())
        .map((id) => {
          const record = byId.get(id);
          if (!record) {
            return "";
          }
          let n = numbers.get(id);
          if (n === undefined) {
            n = numbers.size + 1;
            numbers.set(id, n);
            added.push({ n, record });
          }
          return `[^${n}]`;
        })
        .join(""),
    );
  }

  return {
    replace(content: string, records: ExportCitation[]) {
      const byId = new Map(records.map((record) => [record.citation, record]));
      const added: Array<{ n: number; record: ExportCitation }> = [];
      const text = content
        .split(CODE_PATTERN)
        .map((segment, index) =>
          index % 2 === 1 ? segment : replaceInText(segment, byId, added),
        )
        .join("");
      return { text, added };
    },
  };
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeInline(value: string) {
  return value.replace(/([\]|])/g, "\\$1");
}

function cutQuote(value: string) {
  const chars = Array.from(oneLine(value));
  return chars.length > MAX_QUOTE_CHARS
    ? `${chars.slice(0, MAX_QUOTE_CHARS).join("")}…`
    : chars.join("");
}

/** `[^n]: Title (link) — "quote"`, always on one line. */
export function formatFootnote(
  n: number,
  record: ExportCitation,
  sourceLabel: string,
): string {
  let line = `[^${n}]: ${escapeInline(oneLine(record.sourceTitle ?? sourceLabel))}`;
  if (record.externalUri) {
    line += ` (${record.externalUri.replace(/\s/g, "%20").replace(/\)/g, "%29")})`;
  }
  if (record.quote) {
    line += ` — "${escapeInline(cutQuote(record.quote))}"`;
  }
  return line;
}
