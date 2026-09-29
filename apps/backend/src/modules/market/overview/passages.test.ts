import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MCP_OVERVIEW_EVIDENCE_MIN_CHARS,
  MCP_OVERVIEW_MAX_PASSAGES,
  findPassages,
  numberMcpOverviewPassages,
  type McpOverviewPassageSources,
  type PassageLevel,
} from "./passages";

/** The text of every citable passage of `text`, in order. */
function passages(text: string, level: PassageLevel = "sentence"): string[] {
  return findPassages(text, level).map(({ start, end }) =>
    text.slice(start, end),
  );
}

const sources = (
  overrides: Partial<McpOverviewPassageSources> = {},
): McpOverviewPassageSources => ({
  description: null,
  readme: null,
  tools: [],
  variables: [],
  ...overrides,
});

/** Rendered text with every inserted `[ID] ` taken out again. */
const withoutIds = (text: string) =>
  text.replace(/\[(?:D|R|T\d+\.|V\d+\.)\d+\] /g, "");

describe("segmentation", () => {
  test("paragraphs split on blank lines", () => {
    assert.deepEqual(
      passages(
        "First paragraph here\n\n\nSecond paragraph here\n \nThird one here",
      ),
      ["First paragraph here", "Second paragraph here", "Third one here"],
    );
  });

  test("wrapped prose joins the item before it", () => {
    const text =
      "A paragraph whose sentence\n  wraps over two lines\nand a third";
    assert.deepEqual(passages(text), [text]);
    // One passage, however it is wrapped: the whole item at item level too.
    assert.deepEqual(passages(text, "item"), [text]);
  });

  test("list items, headings, quotes and table rows start new items", () => {
    const text = [
      "Intro line of the list",
      "- first bullet item",
      "- second bullet item",
      "  wrapped under it",
      "* star bullet item",
      "+ plus bullet item",
      "1. ordered item one",
      "2) ordered item two",
      "## A heading line",
      "Prose right under the heading",
      "> a quoted line here",
      "lazily continued quote",
      "| cell one | cell two |",
      "|---|---|",
      "| cell three | four |",
    ].join("\n");
    assert.deepEqual(passages(text), [
      "Intro line of the list",
      "first bullet item",
      "second bullet item\n  wrapped under it",
      "star bullet item",
      "plus bullet item",
      "ordered item one",
      "ordered item two",
      // A heading and a table row are one line each: the line after them is
      // not their wrapped text.
      "A heading line",
      "Prose right under the heading",
      "a quoted line here\nlazily continued quote",
      "cell one | cell two |",
      // "|---|---|" has no words to cite.
      "cell three | four |",
    ]);
  });

  test("markers need their space; otherwise the line is prose", () => {
    assert.deepEqual(
      passages("Some prose here\n-not a bullet\n#not-a-heading\n3.14 is pi"),
      ["Some prose here\n-not a bullet\n#not-a-heading\n3.14 is pi"],
    );
    // Nested markers are all lead: the ID goes after them.
    const nested = "> - quoted bullet item";
    const [span] = findPassages(nested, "sentence");
    assert.equal(nested.slice(0, span!.start), "> - ");
  });

  test("items split into sentences at . ! ? and their CJK forms before whitespace", () => {
    assert.deepEqual(
      passages(
        "One sentence here. Two sentence here! Three here?\nFour on a new line. 这是一个中文的句子。 最后一个中文的句子！ Version v1.2 stays whole, e.g.this too.",
      ),
      [
        "One sentence here.",
        "Two sentence here!",
        "Three here?",
        "Four on a new line.",
        "这是一个中文的句子。",
        "最后一个中文的句子！",
        "Version v1.2 stays whole, e.g.this too.",
      ],
    );
    // A list item's sentences: the lead belongs to none of them.
    assert.deepEqual(passages("- First item sentence. Second item sentence."), [
      "First item sentence.",
      "Second item sentence.",
    ]);
    // At item level, the item stays whole.
    assert.deepEqual(
      passages("- First item sentence. Second item sentence.", "item"),
      ["First item sentence. Second item sentence."],
    );
  });

  test("fenced code is never numbered, blank lines inside it included", () => {
    const text = [
      "Before the fence here.",
      "```bash",
      "npm install widgets. Then run it.",
      "",
      "- not a list item here",
      "```",
      "After the fence here.",
      "~~~~",
      "```",
      "still code inside tildes",
      "~~~~",
      "````md",
      "```",
      "inner fence is code too",
      "```",
      "````",
      "Last prose line here.",
    ].join("\n");
    assert.deepEqual(passages(text), [
      "Before the fence here.",
      "After the fence here.",
      "Last prose line here.",
    ]);
    // A fence ends the item before it; a backtick run with a backtick in its
    // info string is inline code, not a fence.
    assert.deepEqual(passages("Wrapped prose line\n```x`\nstill prose here"), [
      "Wrapped prose line\n```x`\nstill prose here",
    ]);
    // An unclosed fence runs to the end.
    assert.deepEqual(passages("Prose before it.\n```\nnever closed code"), [
      "Prose before it.",
    ]);
  });

  test("passages shorter than the minimum are not numbered", () => {
    assert.equal(MCP_OVERVIEW_EVIDENCE_MIN_CHARS, 8);
    assert.deepEqual(
      passages(
        [
          "Yes. No. Abcdefg Abcdefgh",
          "- Abcdefg",
          "- Abcdefgh",
          "## Setup",
          // Markers do not count: "Settings" is eight characters.
          "## Settings",
          "- 数据库连接工具",
          "- 数据库的连接工具",
          // Measured as the parser measures evidence: quotation marks,
          // trailing dots, emphasis and code markers set aside.
          "- Abcdefg.",
          "- `x`",
          "- **Note:**",
          '- "Abcdefg"',
          // Nothing to cite without a letter or a digit.
          "- ---- ---- ----",
        ].join("\n"),
      ),
      ["Abcdefg Abcdefgh", "Abcdefgh", "Settings", "数据库的连接工具"],
    );
    // Whitespace is collapsed before counting.
    assert.deepEqual(passages("ab\n        cd"), []);
    assert.deepEqual(passages("abcd\n    efgh"), ["abcd\n    efgh"]);
  });

  test("is deterministic", () => {
    const text = "## Tools\n- search the web. Fast.\n\nMore prose here.";
    assert.deepEqual(
      findPassages(text, "sentence"),
      findPassages(text, "sentence"),
    );
  });
});

describe("numbering", () => {
  test("each source numbers its own passages with its prefix, in place", () => {
    const numbered = numberMcpOverviewPassages(
      sources({
        description: "Search the web for agents. Read pages too.",
        readme: "## Features list\n- Finds pages fast.\n\nRuns locally only.",
        tools: [null, "Searches the web. Returns links.", "Short."],
        variables: ["The API key to use.", null, "A header for tracing."],
      }),
    );
    assert.equal(
      numbered.description,
      "[D1] Search the web for agents. [D2] Read pages too.",
    );
    assert.equal(
      numbered.readme,
      "## [R1] Features list\n- [R2] Finds pages fast.\n\n[R3] Runs locally only.",
    );
    // Tool and variable indexes are their positions, described or not.
    assert.deepEqual(numbered.tools, [
      null,
      "[T2.1] Searches the web. [T2.2] Returns links.",
      "Short.",
    ]);
    assert.deepEqual(numbered.variables, [
      "[V1.1] The API key to use.",
      null,
      "[V3.1] A header for tracing.",
    ]);
    assert.deepEqual(numbered.passages, [
      { id: "D1", text: "Search the web for agents." },
      { id: "D2", text: "Read pages too." },
      { id: "R1", text: "Features list" },
      { id: "R2", text: "Finds pages fast." },
      { id: "R3", text: "Runs locally only." },
      { id: "T2.1", text: "Searches the web." },
      { id: "T2.2", text: "Returns links." },
      { id: "V1.1", text: "The API key to use." },
      { id: "V3.1", text: "A header for tracing." },
    ]);
  });

  test("rendering is otherwise unchanged, and a passage's text is what follows its ID", () => {
    const readme = [
      "# Widgets server",
      "",
      "Widgets for agents, wrapped",
      "   over lines. Second sentence!",
      "",
      "[…]",
      "",
      "| Tool | What it does |",
      "|---|---|",
      "| `list` | Lists every widget. Free. |",
      "",
      "```json",
      '{ "a": "Not numbered at all." }',
      "```",
      "",
      "[…]",
    ].join("\n");
    const numbered = numberMcpOverviewPassages(sources({ readme }));
    assert.equal(withoutIds(numbered.readme!), readme);
    for (const passage of numbered.passages) {
      assert.ok(
        numbered.readme!.includes(`[${passage.id}] ${passage.text}`),
        passage.id,
      );
    }
    assert.deepEqual(
      numbered.passages.map((passage) => passage.text),
      [
        "Widgets server",
        "Widgets for agents, wrapped\n   over lines.",
        "Second sentence!",
        "Tool | What it does |",
        "`list` | Lists every widget.",
      ],
    );
    // The omission markers stay as they were, outside every passage.
    assert.equal(numbered.readme!.match(/^\[…\]$/gm)?.length, 2);
    assert.ok(
      numbered.passages.every((passage) => !passage.text.includes("[…]")),
    );
  });

  test("no citable text, no passages", () => {
    const numbered = numberMcpOverviewPassages(
      sources({
        description: "Tiny.",
        readme: "```\ncode only\n```",
        tools: [null],
      }),
    );
    assert.deepEqual(numbered.passages, []);
    assert.equal(numbered.description, "Tiny.");
    assert.equal(numbered.readme, "```\ncode only\n```");
  });

  test("over the cap, the README falls back to whole items", () => {
    assert.equal(MCP_OVERVIEW_MAX_PASSAGES, 500);
    // Three items of 200 sentences each: 600 sentences, three items.
    const item = (label: string) =>
      Array.from(
        { length: 200 },
        (_, index) => `${label} sentence ${index}.`,
      ).join(" ");
    const readme = [
      "- " + item("Alpha"),
      "- " + item("Beta"),
      "- " + item("Gamma"),
    ].join("\n");
    const numbered = numberMcpOverviewPassages(
      sources({
        description: "The first sentence. The second sentence.",
        readme,
        tools: ["Tool sentence one. Tool sentence two."],
      }),
    );
    assert.deepEqual(
      numbered.passages.map((passage) => passage.id),
      ["D1", "D2", "R1", "R2", "R3", "T1.1", "T1.2"],
    );
    assert.equal(numbered.passages[2]!.text, item("Alpha"));
    assert.ok(numbered.readme!.startsWith("- [R1] Alpha sentence 0. Alpha"));
    assert.equal(withoutIds(numbered.readme!), readme);
  });

  test("still over the cap, the README gets what the other sources leave", () => {
    const readme = Array.from(
      { length: 600 },
      (_, index) => `- README item number ${index}.`,
    ).join("\n");
    const numbered = numberMcpOverviewPassages(
      sources({
        description: "The first sentence. The second sentence.",
        readme,
        tools: ["Tool sentence one."],
        variables: ["Variable sentence one."],
      }),
    );
    const ids = numbered.passages.map((passage) => passage.id);
    assert.equal(ids.length, MCP_OVERVIEW_MAX_PASSAGES);
    assert.deepEqual(ids.slice(0, 2), ["D1", "D2"]);
    assert.deepEqual(ids.slice(-2), ["T1.1", "V1.1"]);
    // 496 README items, in document order; the rest stay unnumbered.
    assert.equal(ids.filter((id) => id.startsWith("R")).length, 496);
    assert.equal(ids.at(-3), "R496");
    const lines = numbered.readme!.split("\n");
    assert.equal(lines[495], "- [R496] README item number 495.");
    assert.equal(lines[496], "- README item number 496.");
    assert.equal(withoutIds(numbered.readme!), readme);
  });

  test("the description, tools and variables come first under the budget", () => {
    const numbered = numberMcpOverviewPassages(
      sources({
        description: "The first sentence. The second sentence.",
        readme: "A readme sentence. Another readme sentence.",
        tools: ["Tool sentence one. Tool sentence two."],
      }),
      3,
    );
    assert.deepEqual(
      numbered.passages.map((passage) => passage.id),
      ["D1", "D2", "T1.1"],
    );
    assert.equal(
      numbered.tools[0],
      "[T1.1] Tool sentence one. Tool sentence two.",
    );
    assert.equal(
      numbered.readme,
      "A readme sentence. Another readme sentence.",
    );
  });

  test("is deterministic", () => {
    const input = sources({
      description: "Search the web for agents. Read pages too.",
      readme: "## Features list\n- Finds pages fast.",
      tools: ["Searches the web."],
    });
    assert.deepEqual(
      numberMcpOverviewPassages(input),
      numberMcpOverviewPassages(input),
    );
  });
});
