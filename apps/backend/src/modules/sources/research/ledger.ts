import type { ResearchLedgerEntry } from "@sourceweft/contracts/source-research";

export type LedgerEntry = ResearchLedgerEntry;

const QUOTE_MAX_CHARS = 400;

/** Adds a page to the ledger; the same url is never added twice. */
export function addLedgerEntry(
  ledger: LedgerEntry[],
  entry: Omit<LedgerEntry, "id">,
  caps: { maxPages: number },
): LedgerEntry[] {
  if (ledger.some((existing) => existing.url === entry.url)) return ledger;
  if (ledger.length >= caps.maxPages) {
    throw new Error(`Research ledger is full (${caps.maxPages} pages)`);
  }
  return [
    ...ledger,
    {
      ...entry,
      id: `e${ledger.length + 1}`,
      quotes: entry.quotes.map((quote) => quote.slice(0, QUOTE_MAX_CHARS)),
    },
  ];
}
