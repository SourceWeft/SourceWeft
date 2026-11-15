import type { StudyKind } from "@sourceweft/contracts/study";
import type {
  CorpusChunkInput,
  GenerateStudyInput,
  StudyAnchorPort,
  StudyCheckpoint,
  StudyCheckpointStore,
  StudyModelPort,
} from "../src/engine/types";

export type ModelCall = Parameters<StudyModelPort["completeStructured"]>[0];

/**
 * A scripted model: `respond` decides each answer from the call. Every call is
 * recorded so tests can count them and read their keys and prompts.
 */
export function stubModel(respond: (call: ModelCall) => unknown | Promise<unknown>) {
  const calls: ModelCall[] = [];
  const model: StudyModelPort = {
    async completeStructured(call) {
      calls.push(call);
      return respond(call);
    },
  };
  return { model, calls };
}

const FACT = /FACT-\d+/g;

/**
 * Anchors a claim when the chunk contains one of the claim's `FACT-n` tokens,
 * standing in for the host's lexical/semantic anchoring.
 */
export function factAnchor(): StudyAnchorPort & { requests: number } {
  const port = {
    requests: 0,
    async anchor(requests: readonly { text: string; chunkContent: string }[]) {
      port.requests += requests.length;
      return requests.map(({ text, chunkContent }) => {
        for (const fact of text.match(FACT) ?? []) {
          const start = chunkContent.indexOf(fact);
          if (start >= 0) {
            const end = Math.min(chunkContent.length, start + fact.length + 20);
            return {
              startChar: start,
              endChar: end,
              quote: chunkContent.slice(start, end),
              confidence: 0.9,
            };
          }
        }
        return null;
      });
    },
  };
  return port;
}

export function memoryCheckpoint(): StudyCheckpointStore & {
  value: StudyCheckpoint | null;
  saves: number;
} {
  const store = {
    value: null as StudyCheckpoint | null,
    saves: 0,
    async load() {
      return store.value ? structuredClone(store.value) : null;
    },
    async save(checkpoint: StudyCheckpoint) {
      store.saves += 1;
      store.value = structuredClone(checkpoint);
    },
  };
  return store;
}

/** `count` chunks, each stating FACT-<n> with filler to reach `tokens` each. */
export function factChunks(
  count: number,
  options: { tokens?: number; documentId?: string; language?: string } = {},
): CorpusChunkInput[] {
  const tokens = options.tokens ?? 50;
  return Array.from({ length: count }, (_, index) => {
    const fact = `FACT-${index + 1} is a statement about topic ${index + 1}.`;
    const filler = " lorem".repeat(Math.max(0, Math.ceil((tokens * 4 - fact.length) / 6)));
    return {
      chunkId: `chunk-${options.documentId ?? "d1"}-${index}`,
      sourceId: "source-1",
      documentId: options.documentId ?? "d1",
      chunkNo: index,
      headingPath: `Section ${Math.floor(index / 4) + 1}`,
      language: options.language ?? "en",
      text: `${fact}${filler}`,
    };
  });
}

export function baseInput(
  kind: StudyKind,
  chunks: CorpusChunkInput[],
  overrides: Partial<GenerateStudyInput> = {},
): GenerateStudyInput {
  return {
    kind,
    artifactId: "art_1",
    versionNo: 1,
    chunks,
    options: { count: 5, difficulty: "mixed", language: "en" },
    recipe: { options: {}, sourceIds: ["source-1"] },
    inputs: {
      selection: "sources",
      sources: [{ sourceId: "source-1", documentId: "d1", contentHash: "hash-1" }],
    },
    modelAlias: "test-model",
    rootLabel: "Sources",
    ...overrides,
  };
}

/** Handles of the chunks in a generation prompt, in order. */
export function promptHandles(user: string): string[] {
  return [...user.matchAll(/<<<CHUNK (c\d+)/g)].map((match) => match[1]!);
}

/** The item count a generation prompt asked for. */
export function promptCount(user: string): number {
  const match = user.match(/Write (\d+) (flashcards|quiz questions)|at most (\d+) nodes/);
  return Number(match?.[1] ?? match?.[3]);
}

const WORDS =
  "amber basin cedar delta ember fjord grove harbor island jungle karst lagoon meadow nebula oasis prairie quartz ridge savanna tundra upland valley willow xenon yarrow zephyr bramble cobalt dune estuary".split(
    " ",
  );

/** A phrase unique to `n`, so near-duplicate removal leaves fixtures alone. */
export function phrase(n: number) {
  return [0, 1, 2, 3, 4]
    .map((i) => WORDS[(n * (i * 7 + 3) + i * 11) % WORDS.length])
    .join(" ");
}

/** Flashcards citing each handle in the prompt, one per handle, up to `limit`. */
export function cardsFor(user: string, limit = Infinity) {
  return {
    cards: promptHandles(user)
      .slice(0, limit)
      .map((handle) => {
        const n = Number(handle.slice(1));
        return {
          front: `What about ${phrase(n)}?`,
          back: `FACT-${n} is a statement about topic ${n}.`,
          hint: null,
          tags: ["topic"],
          difficulty: ((n % 3) + 1) as 1 | 2 | 3,
          refs: [handle],
        };
      }),
  };
}

export function questionsFor(user: string, limit = Infinity) {
  return {
    questions: promptHandles(user)
      .slice(0, limit)
      .map((handle) => {
        const n = Number(handle.slice(1));
        return {
          type: "single",
          stem: `Which statement fits ${phrase(n)}?`,
          options: [`FACT-${n} holds`, "Something else", "Another thing", "None"],
          correct: [0],
          referenceAnswer: null,
          explanation: `FACT-${n} is a statement about topic ${n}.`,
          difficulty: ((n % 3) + 1) as 1 | 2 | 3,
          refs: [handle],
        };
      }),
  };
}

/** Verdicts that agree with option 0 being the only correct one. */
export const AGREE_FIRST_OPTION = {
  determinable: true,
  verdicts: [
    { option: 0, supported: true },
    { option: 1, supported: false },
    { option: 2, supported: false },
    { option: 3, supported: false },
  ],
};
