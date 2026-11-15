import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Hex } from "../src/sha256";
import {
  STUDY_ARTIFACT_TYPES,
  STUDY_PAYLOAD_MAX_BYTES,
  assertStudyPayloadSize,
  flashcardItemSchema,
  mindmapNodeSchema,
  newStudyItemId,
  parseStudyContentForArtifact,
  quizItemSchema,
  reviewGradeSchema,
  studyContentSchema,
  studyErrorCodeSchema,
  studyEvidenceSchema,
  studyFingerprint,
  studyGenerateRequestSchema,
  submitAnswersSchema,
} from "../src/study";

const QUOTE = "Photosynthesis converts light energy into chemical energy.";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    kind: "chunk",
    sourceId: "src_1",
    documentId: "doc_1",
    chunkId: "chunk_1",
    chunkNo: 3,
    headingPath: "Biology > Plants",
    quote: QUOTE,
    startChar: 10,
    endChar: 10 + QUOTE.length,
    quoteHash: `sha256:${sha256Hex(QUOTE)}`,
    ...overrides,
  };
}

function flashcard(overrides: Record<string, unknown> = {}) {
  return {
    id: "c_0b6f6f0e",
    fingerprint: "0123456789abcdef",
    front: "What does photosynthesis convert?",
    back: "Light energy into chemical energy.",
    hint: null,
    tags: ["biology"],
    difficulty: 2,
    evidence: [evidence()],
    ...overrides,
  };
}

function quizItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "q_0b6f6f0e",
    fingerprint: "0123456789abcdef",
    type: "single",
    stem: "What does photosynthesis convert light into?",
    options: ["Chemical energy", "Sound", "Pressure", "Magnetism"],
    correct: [0],
    explanation: "The source says light becomes chemical energy.",
    difficulty: 1,
    evidence: [evidence()],
    ...overrides,
  };
}

function mindmapNode(
  id: string,
  children: unknown[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    fingerprint: "0123456789abcdef",
    label: `Node ${id}`,
    summary: null,
    children,
    evidence: [evidence()],
    ...overrides,
  };
}

const inputs = {
  selection: "sources",
  sources: [
    {
      sourceId: "src_1",
      documentId: "doc_1",
      contentHash: `sha256:${"a".repeat(64)}`,
    },
  ],
};

function generation(overrides: Record<string, unknown> = {}) {
  return {
    promptVersion: "study-v1",
    modelAlias: "chat-default",
    mode: "single",
    stats: {
      requested: 20,
      kept: 1,
      dropped: { schema: 0, unanchored: 1 },
      groups: 1,
      tokensEstimated: 1200,
    },
    recipe: {
      options: { size: "standard", difficulty: "mixed" },
      focus: "chapter 2",
      sourceIds: ["src_1"],
    },
    ...overrides,
  };
}

function content(kind: string, overrides: Record<string, unknown> = {}) {
  const base = {
    schemaVersion: 1,
    kind,
    language: "en",
    inputs,
    generation: generation(),
  };
  if (kind === "flashcards") return { ...base, items: [flashcard()], ...overrides };
  if (kind === "quiz") return { ...base, items: [quizItem()], ...overrides };
  return { ...base, root: mindmapNode("n_root", [mindmapNode("n_a")]), ...overrides };
}

test("the three study artifact types match the artifact type enum", () => {
  assert.deepEqual([...STUDY_ARTIFACT_TYPES], ["flashcards", "quiz", "mindmap"]);
});

test("valid content of every kind round-trips", () => {
  for (const kind of STUDY_ARTIFACT_TYPES) {
    const value = content(kind);
    const parsed = studyContentSchema.parse(value);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), value);
    assert.deepEqual(parseStudyContentForArtifact(kind, value), parsed);
  }
});

test("content whose kind differs from the artifact type is rejected", () => {
  assert.throws(
    () => parseStudyContentForArtifact("quiz", content("flashcards")),
    /does not match/,
  );
  assert.throws(() =>
    studyContentSchema.parse({ ...content("quiz"), kind: "table" }),
  );
});

test("content must carry schemaVersion 1 and at least one item", () => {
  assert.throws(() =>
    studyContentSchema.parse(content("quiz", { schemaVersion: 2 })),
  );
  assert.throws(() => studyContentSchema.parse(content("quiz", { items: [] })));
});

test("item ids must be unique within one content", () => {
  assert.throws(() =>
    studyContentSchema.parse(
      content("flashcards", {
        items: [flashcard(), flashcard({ front: "other" })],
      }),
    ),
  );
  assert.throws(() =>
    studyContentSchema.parse(
      content("mindmap", {
        root: mindmapNode("n_root", [mindmapNode("n_root")]),
      }),
    ),
  );
});

test("evidence is bounded and carries a verifiable quote hash", () => {
  assert.ok(studyEvidenceSchema.safeParse(evidence()).success);
  assert.ok(!studyEvidenceSchema.safeParse(evidence({ quote: "" })).success);
  assert.ok(
    !studyEvidenceSchema.safeParse(evidence({ quote: "x".repeat(601) })).success,
  );
  assert.ok(
    !studyEvidenceSchema.safeParse(evidence({ quoteHash: "abc" })).success,
  );
  assert.ok(
    !studyEvidenceSchema.safeParse(evidence({ startChar: 9, endChar: 3 }))
      .success,
  );
  assert.ok(
    studyEvidenceSchema.safeParse(
      evidence({ chunkNo: undefined, headingPath: null, startChar: undefined, endChar: undefined }),
    ).success,
  );
});

test("flashcards need one to three evidence entries and a valid difficulty", () => {
  assert.ok(flashcardItemSchema.safeParse(flashcard()).success);
  assert.ok(!flashcardItemSchema.safeParse(flashcard({ evidence: [] })).success);
  assert.ok(
    !flashcardItemSchema.safeParse(
      flashcard({ evidence: [evidence(), evidence(), evidence(), evidence()] }),
    ).success,
  );
  assert.ok(!flashcardItemSchema.safeParse(flashcard({ difficulty: 4 })).success);
  assert.ok(!flashcardItemSchema.safeParse(flashcard({ id: "q_1" })).success);
});

test("a single-choice question has exactly one correct option", () => {
  assert.ok(quizItemSchema.safeParse(quizItem()).success);
  assert.ok(
    !quizItemSchema.safeParse(quizItem({ correct: [0, 1] })).success,
  );
  assert.ok(!quizItemSchema.safeParse(quizItem({ correct: [] })).success);
});

test("correct indices must be unique and inside the options", () => {
  assert.ok(!quizItemSchema.safeParse(quizItem({ correct: [4] })).success);
  assert.ok(!quizItemSchema.safeParse(quizItem({ correct: [-1] })).success);
  assert.ok(
    !quizItemSchema.safeParse(quizItem({ type: "multi", correct: [1, 1] }))
      .success,
  );
  assert.ok(
    quizItemSchema.safeParse(quizItem({ type: "multi", correct: [1, 2] }))
      .success,
  );
});

test("options hold two to six entries", () => {
  assert.ok(!quizItemSchema.safeParse(quizItem({ options: ["only"], correct: [0] })).success);
  assert.ok(
    !quizItemSchema.safeParse(
      quizItem({ options: ["a", "b", "c", "d", "e", "f", "g"] }),
    ).success,
  );
});

test("true/false questions use the two fixed options", () => {
  const ok = quizItem({
    type: "truefalse",
    options: ["true", "false"],
    correct: [1],
  });
  assert.ok(quizItemSchema.safeParse(ok).success);
  assert.ok(
    !quizItemSchema.safeParse({ ...ok, options: ["yes", "no"] }).success,
  );
  assert.ok(
    !quizItemSchema.safeParse({ ...ok, options: ["false", "true"] }).success,
  );
  assert.ok(!quizItemSchema.safeParse({ ...ok, correct: [0, 1] }).success);
});

test("short answer questions carry a reference answer and no options", () => {
  const short = {
    ...quizItem({ type: "short" }),
    options: undefined,
    correct: undefined,
    referenceAnswer: "Chemical energy.",
  };
  assert.ok(quizItemSchema.safeParse(short).success);
  assert.ok(!quizItemSchema.safeParse({ ...short, referenceAnswer: undefined }).success);
  assert.ok(
    !quizItemSchema.safeParse({ ...short, options: ["a", "b"], correct: [0] })
      .success,
  );
});

test("mindmap nodes bound label, summary, depth, fan-out and total size", () => {
  assert.ok(
    mindmapNodeSchema.safeParse(mindmapNode("n_1", [], { evidence: [] })).success,
  );
  assert.ok(
    !mindmapNodeSchema.safeParse(mindmapNode("n_1", [], { label: "x".repeat(41) }))
      .success,
  );
  assert.ok(
    !mindmapNodeSchema.safeParse(
      mindmapNode("n_1", [], { summary: "x".repeat(201) }),
    ).success,
  );

  const wide = mindmapNode(
    "n_root",
    Array.from({ length: 9 }, (_, i) => mindmapNode(`n_${i}`)),
  );
  assert.throws(() => studyContentSchema.parse(content("mindmap", { root: wide })));

  // root + 4 levels is allowed, a fifth level below the root is not.
  const chain = (depth: number): unknown =>
    mindmapNode(`n_d${depth}`, depth === 0 ? [] : [chain(depth - 1)]);
  assert.ok(studyContentSchema.safeParse(content("mindmap", { root: chain(4) })).success);
  assert.throws(() => studyContentSchema.parse(content("mindmap", { root: chain(5) })));

  // 1 + 8 + 8*8 = 73 nodes; seven more below one grandchild makes exactly 80,
  // an eighth makes 81.
  const tree = (extra: number): unknown =>
    mindmapNode(
      "n_root",
      Array.from({ length: 8 }, (_, i) =>
        mindmapNode(
          `n_${i}`,
          Array.from({ length: 8 }, (_, j) =>
            mindmapNode(
              `n_${i}_${j}`,
              i === 0 && j === 0
                ? Array.from({ length: extra }, (_, k) => mindmapNode(`n_x${k}`))
                : [],
            ),
          ),
        ),
      ),
    );
  assert.ok(studyContentSchema.safeParse(content("mindmap", { root: tree(7) })).success);
  assert.throws(() => studyContentSchema.parse(content("mindmap", { root: tree(8) })));
});

test("fingerprints ignore case, spacing and punctuation", () => {
  const a = studyFingerprint("flashcards", "What is  Photosynthesis?");
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.equal(a, studyFingerprint("flashcards", "what is photosynthesis"));
  assert.equal(a, studyFingerprint("flashcards", " What is, photosynthesis!! "));
  assert.notEqual(a, studyFingerprint("flashcards", "What is respiration?"));
  assert.notEqual(a, studyFingerprint("quiz", "What is Photosynthesis?"));
});

test("fingerprints keep Chinese text apart", () => {
  const a = studyFingerprint("quiz", "光合作用是什么？");
  assert.equal(a, studyFingerprint("quiz", "光合作用是什么"));
  assert.notEqual(a, studyFingerprint("quiz", "呼吸作用是什么？"));
  assert.notEqual(
    studyFingerprint("quiz", "？！"),
    studyFingerprint("quiz", "。。。。a"),
  );
});

test("new item ids are unique and carry the kind prefix", () => {
  const ids = new Set(
    Array.from({ length: 200 }, () => newStudyItemId("flashcards")),
  );
  assert.equal(ids.size, 200);
  assert.ok([...ids].every((id) => /^c_[A-Za-z0-9]+$/.test(id)));
  assert.match(newStudyItemId("quiz"), /^q_[A-Za-z0-9]+$/);
  assert.match(newStudyItemId("mindmap"), /^n_[A-Za-z0-9]+$/);
  assert.ok(flashcardItemSchema.safeParse(flashcard({ id: newStudyItemId("flashcards") })).success);
});

test("the portable sha256 matches node:crypto", () => {
  for (const text of [
    "",
    "abc",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(64),
    "光合作用 \u{1F331}",
    "long ".repeat(1000),
  ]) {
    assert.equal(
      sha256Hex(text),
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
  }
});

test("a generate request needs one to fifty sources", () => {
  const base = { threadId: "thr_1", artifactType: "quiz", sourceIds: ["s1"] };
  assert.ok(studyGenerateRequestSchema.safeParse(base).success);
  assert.ok(!studyGenerateRequestSchema.safeParse({ ...base, sourceIds: [] }).success);
  assert.ok(
    !studyGenerateRequestSchema.safeParse({
      ...base,
      sourceIds: Array.from({ length: 51 }, (_, i) => `s${i}`),
    }).success,
  );
  assert.ok(
    studyGenerateRequestSchema.safeParse({
      ...base,
      sourceIds: Array.from({ length: 50 }, (_, i) => `s${i}`),
    }).success,
  );
  assert.ok(!studyGenerateRequestSchema.safeParse({ ...base, artifactType: "table" }).success);
});

test("generate options bound count, focus, size, difficulty and visibility", () => {
  const base = { threadId: "thr_1", artifactType: "flashcards", sourceIds: ["s1"] };
  const withOptions = (options: unknown) =>
    studyGenerateRequestSchema.safeParse({ ...base, options });
  assert.ok(withOptions({ count: 60 }).success);
  assert.ok(!withOptions({ count: 0 }).success);
  assert.ok(!withOptions({ count: 61 }).success);
  assert.ok(!withOptions({ count: 2.5 }).success);
  assert.ok(withOptions({ focus: "x".repeat(200) }).success);
  assert.ok(!withOptions({ focus: "x".repeat(201) }).success);
  for (const size of ["fewer", "standard", "more"]) {
    assert.ok(withOptions({ size }).success);
  }
  assert.ok(!withOptions({ size: "huge" }).success);
  assert.ok(withOptions({ difficulty: "hard", language: "zh-CN" }).success);
  assert.ok(!withOptions({ difficulty: "insane" }).success);
  assert.ok(studyGenerateRequestSchema.safeParse({ ...base, visibility: "workspace" }).success);
  assert.ok(!studyGenerateRequestSchema.safeParse({ ...base, visibility: "public" }).success);

  // Quiz questions top out at 30, so 31 is out of range for a quiz only.
  assert.ok(
    !studyGenerateRequestSchema.safeParse({
      ...base,
      artifactType: "quiz",
      options: { count: 31 },
    }).success,
  );
  assert.ok(
    studyGenerateRequestSchema.safeParse({
      ...base,
      artifactType: "quiz",
      options: { count: 30 },
    }).success,
  );
});

test("the payload size guard counts UTF-8 bytes", () => {
  assert.doesNotThrow(() => assertStudyPayloadSize({ a: "small" }));
  assert.throws(
    () => assertStudyPayloadSize({ text: "x".repeat(STUDY_PAYLOAD_MAX_BYTES) }),
    /512 KB|too large/i,
  );
  // 3 bytes per character: well under the limit as characters, over as bytes.
  assert.throws(() =>
    assertStudyPayloadSize({
      text: "汉".repeat(Math.ceil(STUDY_PAYLOAD_MAX_BYTES / 3)),
    }),
  );
});

test("review grades and error codes are closed sets", () => {
  for (const grade of [1, 2, 3, 4]) {
    assert.ok(reviewGradeSchema.safeParse(grade).success);
  }
  for (const grade of [0, 5, "3", 2.5]) {
    assert.ok(!reviewGradeSchema.safeParse(grade).success);
  }
  assert.deepEqual(studyErrorCodeSchema.options, [
    "INSUFFICIENT_CREDITS",
    "INPUT_TOO_LARGE",
    "NO_INDEXED_SOURCES",
    "MODEL_UNAVAILABLE",
    "GENERATION_QUALITY_TOO_LOW",
    "SOURCE_NOT_READABLE",
  ]);
});

test("quiz answers carry selections or a self grade, nothing else", () => {
  assert.ok(
    submitAnswersSchema.safeParse({
      answers: { q_1: { selected: [0] }, q_2: { selfGrade: "missed" } },
      finish: true,
    }).success,
  );
  assert.ok(!submitAnswersSchema.safeParse({ answers: { q_1: { selected: [-1] } } }).success);
  assert.ok(!submitAnswersSchema.safeParse({ answers: { q_1: { selfGrade: "maybe" } } }).success);
  assert.ok(!submitAnswersSchema.safeParse({ answers: { q_1: { unknown: 1 } } }).success);
});
