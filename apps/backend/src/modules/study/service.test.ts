import assert from "node:assert/strict";
import { studyContentSchema } from "@sourceweft/contracts/study";
import { expect, test, vi } from "vitest";
import {
  StudyGenerationError,
  type CorpusChunkInput,
  type StudyAnchorPort,
  type StudyModelPort,
} from "./engine";
import { runStudyGeneration, type StudyGenerationRequest } from "./service";

const chunks: CorpusChunkInput[] = Array.from({ length: 6 }, (_, index) => ({
  chunkId: `chunk-${index}`,
  sourceId: "src-1",
  documentId: "doc-1",
  chunkNo: index,
  headingPath: null,
  language: "en",
  text: `FACT-${index + 1} is about subject ${index + 1}.`,
}));

const WORDS = ["amber", "basin", "cedar", "delta", "ember", "fjord", "grove", "harbor"];

function cardsModel(): StudyModelPort & { calls: number } {
  const port = {
    calls: 0,
    async completeStructured(call: { operation: string; user: string }) {
      port.calls += 1;
      if (call.operation.endsWith(".verify")) return { supported: true };
      const handles = [...call.user.matchAll(/<<<CHUNK (c\d+)/g)].map((m) => m[1]!);
      return {
        cards: handles.map((handle, index) => ({
          front: `Recall ${WORDS[index]} ${WORDS[(index + 3) % 8]} ${WORDS[(index + 5) % 8]}?`,
          back: `FACT-${handle.slice(1)} is about subject ${handle.slice(1)}.`,
          hint: null,
          tags: [],
          difficulty: 2,
          refs: [handle],
        })),
      };
    },
  };
  return port;
}

const anchor: StudyAnchorPort = {
  async anchor(requests) {
    return requests.map(({ text, chunkContent }) => {
      const fact = text.match(/FACT-\d+/)?.[0];
      const start = fact ? chunkContent.indexOf(fact) : -1;
      return start < 0
        ? null
        : {
            startChar: start,
            endChar: chunkContent.length,
            quote: chunkContent.slice(start),
            confidence: 1,
          };
    });
  },
};

const request: StudyGenerationRequest = {
  teamId: "team-1",
  workspaceId: "ws-1",
  threadId: "thread-1",
  artifactId: "art-1",
  versionNo: 1,
  userId: "user-1",
  kind: "flashcards",
  sourceIds: ["src-1"],
  options: { count: 5, focus: "  subjects  " },
  uiLocale: "en",
  scopeId: "job-1",
};

const payerPorts = {
  resolveAccess: async () => ({}) as never,
  resolveResponsibleUserId: async () => "owner",
  resolveBillingOrganizationId: async () => "billing-org",
};

test("generates content from the corpus with the recipe, inputs and model recorded", async () => {
  const model = cardsModel();
  const createModelPort = vi.fn(() => model);
  const outcome = await runStudyGeneration(request, {
    billing: {} as never,
    payerPorts,
    describeModel: async () => ({ modelAlias: "deepseek/test" }),
    loadCorpus: async () => ({
      chunks,
      sources: [{ sourceId: "src-1", documentId: "doc-1", title: "Doc", contentHash: "h1" }],
    }),
    createModelPort,
    createAnchorPort: () => anchor,
  });
  const content = studyContentSchema.parse(outcome.content);
  assert.equal(content.kind, "flashcards");
  assert.equal(content.generation.modelAlias, "deepseek/test");
  assert.deepEqual(content.generation.recipe, {
    options: { count: 5, focus: "  subjects  " },
    focus: "subjects",
    sourceIds: ["src-1"],
  });
  assert.deepEqual(content.inputs.sources, [
    { sourceId: "src-1", documentId: "doc-1", contentHash: "h1" },
  ]);
  assert.deepEqual(outcome.payer, { userId: "user-1", billingOrganizationId: "billing-org" });
  expect(createModelPort).toHaveBeenCalledWith({
    payer: { userId: "user-1", billingOrganizationId: "billing-org" },
    request,
  });
});

test("no payer: SOURCE_NOT_READABLE before any source is read or model called", async () => {
  const loadCorpus = vi.fn();
  const model = cardsModel();
  await assert.rejects(
    runStudyGeneration(request, {
      billing: {} as never,
      payerPorts: { ...payerPorts, resolveAccess: async () => null },
      describeModel: async () => ({ modelAlias: "m" }),
      loadCorpus,
      createModelPort: () => model,
      createAnchorPort: () => anchor,
    }),
    (error: unknown) =>
      error instanceof StudyGenerationError && error.code === "SOURCE_NOT_READABLE",
  );
  expect(loadCorpus).not.toHaveBeenCalled();
  assert.equal(model.calls, 0);
});

test("an unavailable default model fails before the corpus is loaded", async () => {
  const loadCorpus = vi.fn();
  await assert.rejects(
    runStudyGeneration(request, {
      billing: {} as never,
      payerPorts,
      describeModel: async () => {
        throw new StudyGenerationError("MODEL_UNAVAILABLE", "down");
      },
      loadCorpus,
      createModelPort: () => cardsModel(),
      createAnchorPort: () => anchor,
    }),
    (error: unknown) =>
      error instanceof StudyGenerationError && error.code === "MODEL_UNAVAILABLE",
  );
  expect(loadCorpus).not.toHaveBeenCalled();
});
