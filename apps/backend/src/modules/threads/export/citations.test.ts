import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createFootnotes,
  formatFootnote,
  readCitationRecords,
  type ExportCitation,
} from "./citations";

function cite(citation: string, overrides: Partial<ExportCitation> = {}) {
  return {
    citation,
    sourceTitle: `Title ${citation}`,
    externalUri: null,
    quote: null,
    ...overrides,
  } satisfies ExportCitation;
}

const records = [cite("c1"), cite("c2")];

test("markers become footnotes numbered across calls", () => {
  const footnotes = createFootnotes();
  const first = footnotes.replace("A[citation:c1] B[citation:c2]", records);
  assert.equal(first.text, "A[^1] B[^2]");
  assert.deepEqual(
    first.added.map((entry) => entry.n),
    [1, 2],
  );

  const second = footnotes.replace("C[citation:c1]", records);
  assert.equal(second.text, "C[^1]");
  assert.deepEqual(second.added, []);
});

test("full-width brackets, comma lists and zero-width spaces are accepted", () => {
  const footnotes = createFootnotes();
  assert.equal(
    footnotes.replace("x【\u200Bcitation: c1 , c2\u200B】", records).text,
    "x[^1][^2]",
  );
});

test("a marker without a source record is removed", () => {
  const footnotes = createFootnotes();
  const result = footnotes.replace("x[citation:nope] y", records);
  assert.equal(result.text, "x y");
  assert.deepEqual(result.added, []);
});

test("markers inside inline code and fenced code stay as text", () => {
  const footnotes = createFootnotes();
  const content = "Use `[citation:c1]` like\n```\n[citation:c1]\n```\nend";
  const result = footnotes.replace(content, records);
  assert.equal(result.text, content);
  assert.deepEqual(result.added, []);
});

test("a footnote shows the title and the quote on one line", () => {
  assert.equal(
    formatFootnote(
      1,
      cite("c1", {
        sourceTitle: "Q3 budget.xlsx",
        quote: "Marketing: 118%\nof plan",
      }),
      "Source",
    ),
    '[^1]: Q3 budget.xlsx — "Marketing: 118% of plan"',
  );
});

test("a web source carries its link", () => {
  assert.equal(
    formatFootnote(
      2,
      cite("c2", {
        sourceTitle: "Report",
        externalUri: "https://example.com/r",
      }),
      "Source",
    ),
    "[^2]: Report (https://example.com/r)",
  );
});

test("long quotes are cut to 200 characters", () => {
  const line = formatFootnote(
    1,
    cite("c1", { sourceTitle: "T", quote: "x".repeat(300) }),
    "Source",
  );
  assert.equal(line, `[^1]: T — "${"x".repeat(200)}…"`);
});

test("brackets and pipes in a quote stay on one line and escaped", () => {
  const line = formatFootnote(
    1,
    cite("c1", { sourceTitle: "T", quote: "a ] b | c\r\nd" }),
    "Source",
  );
  assert.equal(line, '[^1]: T — "a \\] b \\| c d"');
});

test("a missing title uses the source label", () => {
  assert.equal(
    formatFootnote(1, cite("c1", { sourceTitle: null }), "Source"),
    "[^1]: Source",
  );
});

test("records come from retrieval citations, then available citations", () => {
  assert.deepEqual(
    readCitationRecords({
      retrieval: {
        citations: [
          {
            citation: "c1",
            sourceTitle: "Doc",
            excerpt: "excerpt text",
            support: "strong",
            spanText: "span text",
          },
          { citation: "c2", excerpt: "only excerpt", externalUri: "https://e" },
          { nope: true },
        ],
      },
    }),
    [
      {
        citation: "c1",
        sourceTitle: "Doc",
        externalUri: null,
        quote: "span text",
      },
      {
        citation: "c2",
        sourceTitle: null,
        externalUri: "https://e",
        quote: "only excerpt",
      },
    ],
  );
  assert.deepEqual(
    readCitationRecords({
      retrieval: { availableCitations: [{ citation: "a1", excerpt: "e" }] },
    }).map((record) => record.citation),
    ["a1"],
  );
  assert.deepEqual(readCitationRecords({}), []);
});
