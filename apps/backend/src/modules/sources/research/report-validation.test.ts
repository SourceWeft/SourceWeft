import { describe, expect, test } from "vitest";
import type { GroundedAnchorPort } from "@sourceweft/contracts/grounded-generation";
import { addLedgerEntry, type LedgerEntry } from "./ledger";
import { normalizeForQuote, verifyReport } from "./report-validation";

const noEvidence: GroundedAnchorPort = {
  anchor: async (requests) => requests.map(() => null),
};

const entry = (url: string) => ({
  url,
  title: "Title",
  points: ["p"],
  quotes: [],
});

describe("addLedgerEntry", () => {
  test("keeps one entry per url", () => {
    let ledger: LedgerEntry[] = [];
    ledger = addLedgerEntry(ledger, entry("https://a.example/x"), {
      maxPages: 30,
    });
    ledger = addLedgerEntry(ledger, entry("https://a.example/x"), {
      maxPages: 30,
    });
    expect(ledger).toHaveLength(1);
  });

  test("throws when exceeding maxPages", () => {
    let ledger: LedgerEntry[] = [];
    for (let i = 0; i < 30; i++) {
      ledger = addLedgerEntry(ledger, entry(`https://a.example/${i}`), {
        maxPages: 30,
      });
    }
    expect(() =>
      addLedgerEntry(ledger, entry("https://a.example/31"), { maxPages: 30 }),
    ).toThrow();
  });

  test("truncates each quote to 400 characters and assigns unique ids", () => {
    let ledger: LedgerEntry[] = [];
    ledger = addLedgerEntry(
      ledger,
      { ...entry("https://a.example/1"), quotes: ["x".repeat(500)] },
      { maxPages: 30 },
    );
    ledger = addLedgerEntry(ledger, entry("https://a.example/2"), {
      maxPages: 30,
    });
    expect(ledger[0]!.quotes[0]).toHaveLength(400);
    expect(ledger[0]!.id).not.toBe(ledger[1]!.id);
  });
});

describe("normalizeForQuote", () => {
  test("lowercases and collapses whitespace including full-width spaces", () => {
    expect(normalizeForQuote("Hello\n　  World")).toBe("hello world");
  });
});

describe("verifyReport", () => {
  const ledger: LedgerEntry[] = [
    {
      id: "e1",
      url: "https://a.example/1",
      title: "A",
      points: [],
      quotes: [],
    },
  ];
  const pageTexts = new Map([["e1", "The sky is blue.\nIt is   clear today."]]);

  test("unknown entry id fails the whole report", async () => {
    const result = await verifyReport({
      report: "Claim [[e9|whatever]].",
      ledger,
      pageTexts,
      anchor: noEvidence,
    });
    expect(result).toEqual({ ok: false, unknownEntryIds: ["e9"] });
  });

  test("quote differing only in whitespace verifies and is numbered", async () => {
    const result = await verifyReport({
      report: "Sky [[e1|The sky is blue. It is clear today.]] ok.",
      ledger,
      pageTexts,
      anchor: noEvidence,
    });
    expect(result).toEqual({
      ok: true,
      report: "Sky [1] ok.",
      citations: [
        {
          entryId: "e1",
          quote: "The sky is blue. It is clear today.",
          status: "verified",
        },
      ],
    });
  });

  test("unrelated quote is dropped, sentence text kept", async () => {
    const result = await verifyReport({
      report: "Claim [[e1|nothing to do with it]] end.",
      ledger,
      pageTexts,
      anchor: noEvidence,
    });
    expect(result).toEqual({
      ok: true,
      report: "Claim nothing to do with it end.",
      citations: [],
    });
  });

  test("anchor fallback accepts a strong match", async () => {
    const anchor: GroundedAnchorPort = {
      anchor: async (requests) =>
        requests.map(() => ({
          startChar: 0,
          endChar: 5,
          quote: "The s",
          confidence: 0.9,
        })),
    };
    const result = await verifyReport({
      report: "A [[e1|paraphrased sky]].",
      ledger,
      pageTexts,
      anchor,
    });
    expect(result).toMatchObject({ ok: true, report: "A [1]." });
  });

  test("numbers by first appearance and reuses the same number", async () => {
    const two: LedgerEntry[] = [
      ...ledger,
      {
        id: "e2",
        url: "https://a.example/2",
        title: "B",
        points: [],
        quotes: [],
      },
    ];
    const texts = new Map([
      ["e1", "alpha beta"],
      ["e2", "gamma delta"],
    ]);
    const result = await verifyReport({
      report: "[[e2|gamma]] [[e1|alpha]] [[e2|gamma]]",
      ledger: two,
      pageTexts: texts,
      anchor: noEvidence,
    });
    expect(result).toMatchObject({ ok: true, report: "[1] [2] [1]" });
    if (result.ok) expect(result.citations).toHaveLength(2);
  });
});

describe("verifyReport markers with a closing bracket in the quote", () => {
  const ledger: LedgerEntry[] = addLedgerEntry(
    [],
    { url: "https://a.example/x", title: "T", points: ["p"], quotes: [] },
    { maxPages: 30 },
  );

  test("an unknown id is still rejected when its quote contains ]", async () => {
    const result = await verifyReport({
      report: "Sales rose [[e99|sales rose 12% in Q3 [2024] overall]].",
      ledger,
      pageTexts: new Map(),
      anchor: noEvidence,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unknownEntryIds).toContain("e99");
  });

  test("a known id with ] in its quote is parsed, not left raw", async () => {
    const result = await verifyReport({
      report: "Seen [[e1|see note [3] here]] today.",
      ledger,
      pageTexts: new Map([["e1", "We say: see note [3] here, always."]]),
      anchor: noEvidence,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report).not.toContain("[[");
      expect(result.citations).toHaveLength(1);
    }
  });
});
