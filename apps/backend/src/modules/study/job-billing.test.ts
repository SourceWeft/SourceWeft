import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { StudyCorpusChunk } from "@sourceweft/contracts/study-capability";

/**
 * The other half of "no double billing" for the chat entry (the turn half is
 * `threads/agent/capability-tools/study-command-binding.test.ts`): the study
 * job started from a chat tool runs the production model port, and every
 * model call it makes is billed to the person who asked, on the queue job's
 * own `worker-job` scope — never on the chat turn's `thread-turn` scope.
 */

const gateway = vi.hoisted(() => ({
  complete: vi.fn(),
}));

vi.mock("../../shared/model-gateway/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/model-gateway/index")>()),
  completeStructuredWithDefaultChat: gateway.complete,
}));

const { runStudyGeneration } = await import("./service");

const chunks: StudyCorpusChunk[] = Array.from({ length: 4 }, (_, index) => ({
  chunkId: `chunk-${index}`,
  sourceId: "src-1",
  documentId: "doc-1",
  chunkNo: index,
  headingPath: null,
  language: "en",
  text: `FACT-${index + 1} is about subject ${index + 1}.`,
}));

const WORDS = ["amber", "basin", "cedar", "delta", "ember", "fjord", "grove", "harbor"];

test("the job a chat tool queued bills its asker on the job's worker-job scope", async () => {
  gateway.complete.mockReset().mockImplementation(async (call: { operation: string; user: string }) => {
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
  });

  await runStudyGeneration(
    {
      teamId: "team-1",
      workspaceId: "ws-1",
      threadId: "thread-1",
      artifactId: "art-1",
      versionNo: 1,
      userId: "asker-1",
      kind: "flashcards",
      sourceIds: ["src-1"],
      options: { count: 3 },
      uiLocale: "en",
      // The worker passes the queue job id.
      scopeId: "queue-job-7",
    },
    {
      billing: { marker: "worker billing port" } as never,
      payerPorts: {
        resolveAccess: async () => ({}) as never,
        resolveResponsibleUserId: async () => "owner",
        resolveBillingOrganizationId: async () => "asker-billing-org",
      },
      describeModel: async () => ({ modelAlias: "deepseek/test" }),
      loadCorpus: async () => ({
        chunks,
        sources: [{ sourceId: "src-1", documentId: "doc-1", title: "Doc", contentHash: "h1" }],
      }),
      createAnchorPort: () => ({
        async anchor(requests) {
          return requests.map(({ text, chunkContent }) => {
            const fact = text.match(/FACT-\d+/)?.[0];
            const start = fact ? chunkContent.indexOf(fact) : -1;
            return start < 0
              ? null
              : { startChar: start, endChar: chunkContent.length, quote: chunkContent.slice(start), confidence: 1 };
          });
        },
      }),
    },
  );

  assert.ok(gateway.complete.mock.calls.length > 0, "the job made model calls");
  for (const [call] of gateway.complete.mock.calls) {
    assert.equal(call.scopeKind, "worker-job");
    assert.equal(call.scopeId, "queue-job-7");
    assert.equal(call.actorUserId, "asker-1");
    assert.equal(call.teamId, "asker-billing-org");
    assert.deepEqual(call.billing, { marker: "worker billing port" });
  }
});
