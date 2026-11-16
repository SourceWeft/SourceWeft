import {
  studyContentSchema,
  studyFingerprint,
  type MindmapNode,
  type StudyContent,
  type StudyEvidence,
  type StudyKind,
} from "@sourceweft/contracts/study";

/**
 * Fixture payloads for the study viewers: one English and one Chinese payload
 * per artifact type, each parsed through the shared content schema so a
 * fixture that drifts from the contract fails where it is built.
 */

type Content<K extends StudyKind> = Extract<StudyContent, { kind: K }>;

function hash(seed: string) {
  let hex = "";
  for (let i = 0; hex.length < 64; i += 1) {
    hex += ((seed.charCodeAt(i % seed.length) * 31 + i) % 256)
      .toString(16)
      .padStart(2, "0");
  }
  return `sha256:${hex.slice(0, 64)}`;
}

export function fixtureEvidence(
  quote: string,
  overrides: Partial<StudyEvidence> = {},
): StudyEvidence {
  return {
    kind: "chunk",
    sourceId: "source-1",
    documentId: "document-1",
    chunkId: "chunk-1",
    chunkNo: 1,
    headingPath: "Chapter 1 > Photosynthesis",
    quote,
    startChar: 0,
    endChar: quote.length,
    quoteHash: hash(quote),
    ...overrides,
  };
}

function base(kind: StudyKind, language: string) {
  return {
    schemaVersion: 1 as const,
    language,
    inputs: {
      selection: "sources" as const,
      sources: [
        { sourceId: "source-1", documentId: "document-1", contentHash: "hash-1" },
      ],
    },
    generation: {
      promptVersion: `${kind}-v1`,
      modelAlias: "chat-default",
      mode: "single" as const,
      stats: {
        requested: 4,
        kept: 4,
        dropped: {},
        groups: 1,
        tokensEstimated: 1200,
      },
      recipe: { options: { size: "standard" as const }, sourceIds: ["source-1"] },
    },
  };
}

function card(
  id: string,
  front: string,
  back: string,
  quote: string,
  tags: string[] = [],
) {
  return {
    id,
    fingerprint: studyFingerprint("flashcards", front),
    front,
    back,
    tags,
    difficulty: 2 as const,
    evidence: [fixtureEvidence(quote)],
  };
}

export const flashcardsFixtureEn: Content<"flashcards"> = studyContentSchema.parse({
  ...base("flashcards", "en"),
  kind: "flashcards",
  items: [
    card(
      "c_photosynthesis",
      "What does photosynthesis produce?",
      "Glucose and oxygen, from carbon dioxide and water.",
      "Photosynthesis turns carbon dioxide and water into glucose and oxygen.",
      ["biology"],
    ),
    card(
      "c_chlorophyll",
      "Which pigment absorbs light in plants?",
      "Chlorophyll, mostly red and blue light.",
      "Chlorophyll absorbs mostly red and blue light.",
      ["biology", "pigments"],
    ),
    card(
      "c_stomata",
      'What are "stomata", and what do they do?',
      "Pores in the leaf, which let gases in and out.",
      "Stomata are pores that let gases in and out, of the leaf.",
    ),
  ],
}) as Content<"flashcards">;

export const flashcardsFixtureZh: Content<"flashcards"> = studyContentSchema.parse({
  ...base("flashcards", "zh-CN"),
  kind: "flashcards",
  items: [
    card(
      "c_guanghe",
      "光合作用的产物是什么？",
      "葡萄糖和氧气。",
      "光合作用把二氧化碳和水转化为葡萄糖和氧气。",
      ["生物"],
    ),
    card(
      "c_yelvsu",
      "植物中吸收光的色素是什么？",
      "叶绿素，主要吸收红光和蓝光。",
      "叶绿素主要吸收红光和蓝光。",
    ),
  ],
}) as Content<"flashcards">;

function question(item: Record<string, unknown> & { id: string; stem: string }) {
  return {
    fingerprint: studyFingerprint("quiz", item.stem),
    difficulty: 2 as const,
    explanation: "See the cited passage.",
    evidence: [fixtureEvidence(`Passage for ${item.stem}`)],
    ...item,
  };
}

export const quizFixtureEn: Content<"quiz"> = studyContentSchema.parse({
  ...base("quiz", "en"),
  kind: "quiz",
  items: [
    question({
      id: "q_single",
      type: "single",
      stem: "Which gas do plants release during photosynthesis?",
      options: ["Nitrogen", "Oxygen", "Helium"],
      correct: [1],
      explanation: "Oxygen is released as a by-product.",
    }),
    question({
      id: "q_multi",
      type: "multi",
      stem: "Which inputs does photosynthesis need?",
      options: ["Water", "Carbon dioxide", "Salt", "Light"],
      correct: [0, 1, 3],
    }),
    question({
      id: "q_truefalse",
      type: "truefalse",
      stem: "Chlorophyll mostly absorbs green light.",
      options: ["true", "false"],
      correct: [1],
      explanation: "It reflects green light, which is why leaves look green.",
    }),
    question({
      id: "q_short",
      type: "short",
      stem: "Why do leaves look green?",
      referenceAnswer: "Chlorophyll reflects green light.",
    }),
  ],
}) as Content<"quiz">;

export const quizFixtureZh: Content<"quiz"> = studyContentSchema.parse({
  ...base("quiz", "zh-CN"),
  kind: "quiz",
  items: [
    question({
      id: "q_zh_single",
      type: "single",
      stem: "光合作用释放哪种气体？",
      options: ["氮气", "氧气", "氦气"],
      correct: [1],
      explanation: "氧气是光合作用的副产物。",
    }),
    question({
      id: "q_zh_short",
      type: "short",
      stem: "叶子为什么是绿色的？",
      referenceAnswer: "叶绿素反射绿光。",
      explanation: "叶绿素吸收红光和蓝光，反射绿光。",
    }),
  ],
}) as Content<"quiz">;

function node(
  id: string,
  label: string,
  children: MindmapNode[] = [],
  extra: Partial<MindmapNode> = {},
): MindmapNode {
  return {
    id,
    fingerprint: studyFingerprint("mindmap", label),
    label,
    children,
    evidence: [],
    ...extra,
  };
}

export const mindmapFixtureEn: Content<"mindmap"> = studyContentSchema.parse({
  ...base("mindmap", "en"),
  kind: "mindmap",
  root: node("n_root", "Photosynthesis", [
    node(
      "n_inputs",
      "Inputs",
      [node("n_water", "Water"), node("n_co2", "Carbon dioxide"), node("n_light", "Light")],
      {
        summary: "What the plant takes in.",
        evidence: [fixtureEvidence("Plants take in water, carbon dioxide and light.")],
      },
    ),
    node("n_outputs", "Outputs", [
      node("n_glucose", "Glucose", [node("n_starch", "Stored as starch")]),
      node("n_oxygen", "Oxygen"),
    ]),
    node("n_pigments", "Pigments", [node("n_chlorophyll", "Chlorophyll")]),
  ]),
}) as Content<"mindmap">;

export const mindmapFixtureZh: Content<"mindmap"> = studyContentSchema.parse({
  ...base("mindmap", "zh-CN"),
  kind: "mindmap",
  root: node("n_zh_root", "光合作用", [
    node("n_zh_inputs", "原料", [node("n_zh_water", "水"), node("n_zh_co2", "二氧化碳")], {
      summary: "植物吸收的物质。",
      evidence: [fixtureEvidence("植物吸收水和二氧化碳。")],
    }),
    node("n_zh_outputs", "产物", [node("n_zh_glucose", "葡萄糖"), node("n_zh_oxygen", "氧气")]),
  ]),
}) as Content<"mindmap">;

export const studyFixtures = {
  flashcards: { en: flashcardsFixtureEn, zh: flashcardsFixtureZh },
  quiz: { en: quizFixtureEn, zh: quizFixtureZh },
  mindmap: { en: mindmapFixtureEn, zh: mindmapFixtureZh },
} as const;
