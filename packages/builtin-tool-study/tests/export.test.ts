import assert from "node:assert/strict";
import { test } from "node:test";
import { studyContentSchema } from "@sourceweft/contracts/study";
import { deriveFlashcardsFromQuiz } from "../src/derive/cards-from-quiz";
import { exportFlashcardsCsv } from "../src/export/anki-csv";
import {
  exportMindmapJson,
  exportMindmapMarkdown,
  parseMindmapJson,
} from "../src/export/mindmap-outline";
import {
  fixtureEvidence,
  flashcardsFixtureEn,
  flashcardsFixtureZh,
  mindmapFixtureEn,
  quizFixtureEn,
} from "../src/testing/fixtures";

/** Minimal RFC 4180 reader, so the test checks the CSV round-trips, not its text. */
function readCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function dataRows(csv: string) {
  return readCsvRows(
    csv
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n"),
  );
}

test("Anki CSV declares its columns and escapes commas, quotes and newlines", () => {
  const content = {
    ...flashcardsFixtureEn,
    items: [
      {
        ...flashcardsFixtureEn.items[0]!,
        front: 'Say "hi", then\nwave',
        back: "a, b",
        tags: ["two words", "x"],
      },
    ],
  };
  const csv = exportFlashcardsCsv(content);

  assert.match(csv, /^#separator:comma$/m);
  assert.match(csv, /^#html:false$/m);
  assert.match(csv, /^#columns:Front,Back,Source,Tags$/m);
  assert.match(csv, /^#tags column:4$/m);

  const rows = dataRows(csv);
  assert.equal(rows.length, 1);
  const [front, back, source, tags] = rows[0]!;
  assert.equal(front, 'Say "hi", then\nwave');
  assert.equal(back, "a, b");
  assert.match(source!, /Photosynthesis turns carbon dioxide/);
  assert.equal(tags, "two_words x");
});

test("Anki CSV keeps CJK text intact and names the source title when known", () => {
  const csv = exportFlashcardsCsv(flashcardsFixtureZh, {
    sourceTitles: { "source-1": "植物学讲义" },
  });
  const rows = dataRows(csv);
  assert.equal(rows.length, flashcardsFixtureZh.items.length);
  assert.equal(rows[0]![0], "光合作用的产物是什么？");
  assert.equal(rows[0]![1], "葡萄糖和氧气。");
  assert.match(rows[0]![2]!, /^植物学讲义/);
  assert.match(rows[0]![2]!, /光合作用把二氧化碳和水转化为葡萄糖和氧气。/);
});

test("Anki CSV lists every evidence quote in the source column", () => {
  const item = {
    ...flashcardsFixtureEn.items[0]!,
    evidence: [fixtureEvidence("first quote"), fixtureEvidence("second quote")],
  };
  const rows = dataRows(exportFlashcardsCsv({ ...flashcardsFixtureEn, items: [item] }));
  assert.match(rows[0]![2]!, /first quote/);
  assert.match(rows[0]![2]!, /second quote/);
});

test("mind map Markdown nests one bullet level per tree level", () => {
  const markdown = exportMindmapMarkdown(mindmapFixtureEn);
  const lines = markdown.trimEnd().split("\n");
  assert.equal(lines[0], "# Photosynthesis");
  assert.ok(lines.includes("- Inputs — What the plant takes in."));
  assert.ok(lines.includes("  - Water"));
  assert.ok(lines.includes("  - Glucose"));
  assert.ok(lines.includes("    - Stored as starch"));
  // Siblings keep their order.
  assert.ok(lines.indexOf("- Inputs — What the plant takes in.") < lines.indexOf("- Outputs"));
});

test("mind map Markdown escapes characters that would change the outline", () => {
  const content = {
    ...mindmapFixtureEn,
    root: { ...mindmapFixtureEn.root, label: "# not a *heading*", children: [] },
  };
  const markdown = exportMindmapMarkdown(content);
  assert.equal(markdown.split("\n")[0], "# \\# not a \\*heading\\*");
});

test("mind map JSON round-trips the tree", () => {
  const json = exportMindmapJson(mindmapFixtureEn);
  const parsed = parseMindmapJson(json);
  assert.deepEqual(parsed.root, mindmapFixtureEn.root);
  assert.equal(parsed.language, "en");
});

test("deriving cards from a quiz keeps evidence and only the chosen questions", () => {
  const derived = deriveFlashcardsFromQuiz(quizFixtureEn, ["q_short", "q_single"]);

  assert.equal(studyContentSchema.safeParse(derived).success, true);
  assert.equal(derived.kind, "flashcards");
  assert.deepEqual(derived.inputs, quizFixtureEn.inputs);
  assert.equal(derived.items.length, 2);

  // Quiz order is kept, whatever order the ids came in.
  const [single, short] = derived.items;
  assert.equal(single!.front, quizFixtureEn.items[0]!.stem);
  assert.match(single!.back, /^Oxygen/);
  assert.deepEqual(single!.evidence, quizFixtureEn.items[0]!.evidence);

  // A short question has no options to score: the card is stem + reference answer.
  const shortItem = quizFixtureEn.items[3]!;
  assert.equal(short!.front, shortItem.stem);
  assert.equal(short!.back, shortItem.referenceAnswer);
  assert.deepEqual(short!.evidence, shortItem.evidence);

  for (const item of derived.items) {
    assert.match(item.id, /^c_/);
  }
});

test("deriving cards labels true/false answers and lists every correct option", () => {
  const derived = deriveFlashcardsFromQuiz(quizFixtureEn, ["q_multi", "q_truefalse"], {
    trueFalseLabels: { true: "Richtig", false: "Falsch" },
  });
  assert.match(derived.items[0]!.back, /^Water; Carbon dioxide; Light/);
  assert.match(derived.items[1]!.back, /^Falsch/);
});

test("deriving cards from no matching questions throws", () => {
  assert.throws(() => deriveFlashcardsFromQuiz(quizFixtureEn, ["q_missing"]));
});
