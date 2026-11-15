import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { BillingAdmissionError } from "../../shared/model-gateway/index";
import { createStudyAnchorPort } from "./anchor-port";
import { StudyGenerationError } from "./engine";
import { compareStudyFreshness } from "./freshness";
import { createStudyModelPort, describeStudyModel } from "./model-port";
import { resolveStudyPayer } from "./payer";

const call = {
  operation: "study.quiz.generate" as const,
  idempotencyKey: "study:art_1:v1:gen:0",
  referenceId: "artifact:art_1",
  system: "s",
  user: "u",
  schema: { name: "n", description: "d", schema: {} },
  maxTokens: 100,
};

test("the model port calls the default chat helper with the study keys", async () => {
  const complete = vi.fn().mockResolvedValue({ ok: true });
  const port = createStudyModelPort({
    billing: {} as never,
    teamId: "billing-org",
    workspaceId: "ws",
    actorUserId: "user-1",
    scopeId: "job-1",
    complete,
  });
  assert.deepEqual(await port.completeStructured(call), { ok: true });
  expect(complete).toHaveBeenCalledTimes(1);
  const [input] = complete.mock.calls[0]!;
  assert.equal(input.scopeKind, "worker-job");
  assert.equal(input.scopeId, "job-1");
  assert.equal(input.teamId, "billing-org");
  assert.equal(input.actorUserId, "user-1");
  assert.equal(input.idempotencyKey, "study:art_1:v1:gen:0");
  assert.equal(input.referenceId, "artifact:art_1");
  assert.equal(input.operation, "study.quiz.generate");
});

test("a refused admission becomes INSUFFICIENT_CREDITS", async () => {
  const complete = vi
    .fn()
    .mockRejectedValue(new BillingAdmissionError({ allowed: false, reason: "insufficient_credits", availableCredits: 0, billingMode: "credits" } as never));
  const port = createStudyModelPort({
    billing: {} as never,
    teamId: "t",
    workspaceId: "w",
    actorUserId: "u",
    scopeId: "j",
    complete,
  });
  await assert.rejects(
    port.completeStructured(call),
    (error: unknown) =>
      error instanceof StudyGenerationError &&
      error.code === "INSUFFICIENT_CREDITS",
  );
});

test("other model failures pass through for the job to retry", async () => {
  const failure = new Error("upstream 502");
  const port = createStudyModelPort({
    billing: {} as never,
    teamId: "t",
    workspaceId: "w",
    actorUserId: "u",
    scopeId: "j",
    complete: vi.fn().mockRejectedValue(failure),
  });
  await assert.rejects(port.completeStructured(call), (error) => error === failure);
});

test("an unusable default chat model is MODEL_UNAVAILABLE, with no other profile tried", async () => {
  const resolveProfile = vi
    .fn()
    .mockRejectedValue(new Error("Default chat model gateway profile is not configured"));
  await assert.rejects(
    describeStudyModel(resolveProfile),
    (error: unknown) =>
      error instanceof StudyGenerationError && error.code === "MODEL_UNAVAILABLE",
  );
  expect(resolveProfile).toHaveBeenCalledTimes(1);
  expect(resolveProfile).toHaveBeenCalledWith("chat");
});

test("the anchor port finds supporting text and refuses unsupported claims", async () => {
  const port = createStudyAnchorPort();
  const chunk =
    "The mitochondria produce most of the cell's ATP through oxidative phosphorylation. Ribosomes build proteins.";
  const [supported, unsupported] = await port.anchor([
    {
      text: "Mitochondria produce most of the cell's ATP through oxidative phosphorylation.",
      chunkId: "chunk-1",
      chunkContent: chunk,
    },
    {
      text: "Chloroplasts capture sunlight to make glucose in plant leaves.",
      chunkId: "chunk-1",
      chunkContent: chunk,
    },
  ]);
  assert.ok(supported);
  assert.equal(
    chunk.slice(supported.startChar, supported.endChar),
    supported.quote,
  );
  assert.match(supported.quote, /oxidative phosphorylation/);
  assert.equal(unsupported, null);
});

test("the anchor port takes the best of several sentences", async () => {
  const port = createStudyAnchorPort();
  const chunk = "Water boils at 100 degrees Celsius at sea level. It freezes at zero.";
  const [result] = await port.anchor([
    {
      text: "This is a filler remark. Water boils at 100 degrees Celsius at sea level.",
      chunkId: "c",
      chunkContent: chunk,
    },
  ]);
  assert.ok(result);
  assert.match(result.quote, /100 degrees/);
});

test("freshness: changed hash is stale, a missing source is deleted, else fresh", () => {
  const inputs = {
    selection: "sources" as const,
    sources: [
      { sourceId: "a", documentId: "da", contentHash: "h1" },
      { sourceId: "b", documentId: "db", contentHash: "h2" },
    ],
  };
  assert.deepEqual(
    compareStudyFreshness(inputs, new Map([["a", "h1"], ["b", "h2"]])),
    { state: "fresh", changedSourceIds: [], deletedSourceIds: [] },
  );
  assert.deepEqual(
    compareStudyFreshness(inputs, new Map([["a", "h1"], ["b", "h9"]])),
    { state: "stale", changedSourceIds: ["b"], deletedSourceIds: [] },
  );
  assert.deepEqual(
    compareStudyFreshness(inputs, new Map([["a", "h9"]])),
    { state: "source_deleted", changedSourceIds: ["a"], deletedSourceIds: ["b"] },
  );
});

test("a requester who lost access is never charged: SOURCE_NOT_READABLE", async () => {
  const resolveResponsibleUserId = vi.fn().mockResolvedValue("owner");
  await assert.rejects(
    resolveStudyPayer(
      { workspaceId: "w", teamId: "t", userId: "gone" },
      {
        resolveAccess: async () => null,
        resolveResponsibleUserId,
        resolveBillingOrganizationId: async () => "t",
      },
    ),
    (error: unknown) =>
      error instanceof StudyGenerationError && error.code === "SOURCE_NOT_READABLE",
  );
  expect(resolveResponsibleUserId).not.toHaveBeenCalled();
});

test("the requester pays, settled against their billing organization", async () => {
  const payer = await resolveStudyPayer(
    { workspaceId: "w", teamId: "t", userId: "u1" },
    {
      resolveAccess: async () => ({}) as never,
      resolveResponsibleUserId: async () => "owner",
      resolveBillingOrganizationId: async () => "billing-org",
    },
  );
  assert.deepEqual(payer, { userId: "u1", billingOrganizationId: "billing-org" });
});
