import type { GroundedAnchorPort } from "@sourceweft/contracts/grounded-generation";
import type { ResearchCitation } from "@sourceweft/contracts/source-research";
import type { LedgerEntry } from "./ledger";

const MARKER = /\[\[([^\]|]+)\|([^\]]*?)\]\]/g;

/** Lowercases, unifies full-width spaces and collapses whitespace; words are untouched. */
export function normalizeForQuote(text: string): string {
  return text.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export type VerifyReportResult =
  | { ok: true; report: string; citations: ResearchCitation[] }
  | { ok: false; unknownEntryIds: string[] };

/**
 * Replaces `[[entry-id|quote]]` markers with numbered `[n]` citations when the
 * quote is found in the cited page; unsupported markers are removed and their
 * sentence text kept. An entry id outside the ledger rejects the whole report.
 */
export async function verifyReport(input: {
  report: string;
  ledger: LedgerEntry[];
  pageTexts: Map<string, string>;
  anchor: GroundedAnchorPort;
}): Promise<VerifyReportResult> {
  const known = new Set(input.ledger.map((entry) => entry.id));
  const markers = [...input.report.matchAll(MARKER)].map((match) => ({
    entryId: match[1]!.trim(),
    quote: match[2]!.trim(),
  }));

  const unknownEntryIds = [
    ...new Set(
      markers.map((m) => m.entryId).filter((entryId) => !known.has(entryId)),
    ),
  ];
  if (unknownEntryIds.length > 0) return { ok: false, unknownEntryIds };

  const verdicts = new Map<string, boolean>();
  const pending: { key: string; entryId: string; quote: string }[] = [];
  for (const { entryId, quote } of markers) {
    const key = `${entryId}\u0000${quote}`;
    if (verdicts.has(key) || pending.some((p) => p.key === key)) continue;
    const pageText = input.pageTexts.get(entryId) ?? "";
    const needle = normalizeForQuote(quote);
    if (needle && normalizeForQuote(pageText).includes(needle)) {
      verdicts.set(key, true);
    } else if (!needle || !pageText) {
      verdicts.set(key, false);
    } else {
      pending.push({ key, entryId, quote });
    }
  }

  if (pending.length > 0) {
    const results = await input.anchor.anchor(
      pending.map((p) => ({
        text: p.quote,
        chunkId: p.entryId,
        chunkContent: input.pageTexts.get(p.entryId) ?? "",
      })),
    );
    pending.forEach((p, index) => {
      verdicts.set(p.key, (results[index] ?? null) !== null);
    });
  }

  const numbers = new Map<string, number>();
  const citations: ResearchCitation[] = [];
  const report = input.report.replace(
    MARKER,
    (_all, rawId: string, rawQuote: string) => {
      const entryId = rawId.trim();
      const quote = rawQuote.trim();
      const key = `${entryId}\u0000${quote}`;
      if (!verdicts.get(key)) return quote;
      let n = numbers.get(key);
      if (n === undefined) {
        n = numbers.size + 1;
        numbers.set(key, n);
        citations.push({ entryId, quote, status: "verified" });
      }
      return `[${n}]`;
    },
  );
  return { ok: true, report, citations };
}
