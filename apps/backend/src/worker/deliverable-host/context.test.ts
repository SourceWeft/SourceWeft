import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/**
 * These tests exist to protect the idempotency keys, not the plumbing.
 *
 * The deliverable host used to meter by hand under
 * `${jobId}:${operation}:${scopeKey}:${seq}` with `referenceId = artifactId`.
 * It now settles through the billed gateway wrapper instead. If the key format
 * ever drifts, every already-metered deliverable job would be charged a second
 * time on the next deploy — so the format is asserted verbatim here.
 */

const USAGE = { inputTokens: 12, outputTokens: 5 };

const rawMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));

const billingMocks = vi.hoisted(() => ({
  meterBillableModelUsage: vi.fn(),
}));

const profileMocks = vi.hoisted(() => ({
  resolveModelGatewayProfile: vi.fn(),
  requireDefaultModelGatewayProfile: vi.fn(),
}));

// The mock factory below pulls in the real billed-client module graph
// (langchain included) so these tests exercise genuine idempotency-key
// derivation rather than a stub. That import is slow enough to exceed the 5s
// default when the full suite runs files in parallel, which showed up once as
// a spurious failure; the budget here is for module loading, not for any work
// the tests themselves do.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("../../shared/model-gateway/internal/raw", () => rawMocks);

vi.mock("../../modules/content/model-billing", () => billingMocks);

vi.mock("../../shared/model-gateway", async () => {
  const billed = await import("../../shared/model-gateway/billed-client");
  return {
    openBilledModelGateway: billed.openBilledModelGateway,
    resolveModelGatewayProfile: profileMocks.resolveModelGatewayProfile,
    requireDefaultModelGatewayProfile:
      profileMocks.requireDefaultModelGatewayProfile,
  };
});

vi.mock("../../modules/billing", () => ({
  billingService: {
    getSummary: vi.fn(async (teamId: string) => ({
      teamId,
      billingMode: "enforced",
      credits: { available: 1000, consumedThisCycle: 0 },
    })),
  },
}));

// The completion adapter resolves through modules/artifacts/publish, which
// constructs the shared writer at import time, so the mock has to cover every
// repository function that writer binds — not just the ones this test calls.
vi.mock("../../modules/artifacts/repository", () => ({
  createPendingArtifactRecord: vi.fn(),
  createReadyArtifactRecord: vi.fn(),
  findArtifactRecord: vi.fn(),
  findArtifactRecordByRequestKey: vi.fn(),
  findArtifactWriteReferences: vi.fn(),
  markArtifactFailed: vi.fn(),
  markArtifactReady: vi.fn(),
  markArtifactRunning: vi.fn(),
}));

vi.mock("../../modules/sources/storage", () => ({
  artifactStorage: {
    buildArtifactStorageKey: vi.fn(),
    getBucketName: vi.fn(),
    upload: vi.fn(),
  },
  downloadArtifactObject: vi.fn(),
}));

vi.mock("./sandbox-session", () => ({
  createDeliverableSandboxAdapter: vi.fn(),
  loadDefaultSandboxService: vi.fn(async () => null),
}));

const { createDefaultDeliverableRuntimeResolver } = await import("./context");

function profileFor(kind: string) {
  return {
    gatewayConfigId: `gw_${kind}`,
    profileAlias: `p_${kind}`,
    modelAlias: `m_${kind}`,
    configJson: {},
  };
}

function fakeGateway() {
  return {
    chat: {
      complete: vi.fn(async () => ({
        model: "m",
        usage: USAGE,
        raw: { content: "hello" },
      })),
    },
    tts: {
      speech: vi.fn(async () => ({
        audio: new Uint8Array([1, 2, 3]),
        mimeType: "audio/mpeg",
        usage: USAGE,
      })),
    },
    images: {
      generate: vi.fn(async () => ({
        images: [{ b64Json: Buffer.from("x").toString("base64") }],
        usage: USAGE,
      })),
    },
  };
}

const JOB = {
  artifactId: "artifact_1",
  jobId: "job_1",
  teamId: "team_1",
  workspaceId: "ws_1",
  threadId: "thread_1",
  userId: "user_1",
  userMessageId: "msg_1",
  request: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  billingMocks.meterBillableModelUsage.mockImplementation(async () => ({
    billing: {
      teamId: "team_1",
      consumedCredits: 1,
      availableCredits: 999,
      consumedThisCycle: 1,
      idempotencyReplayed: false,
    },
    cost: {
      providerCostUsd: 0.01,
      pricingSnapshot: null,
      costSource: "price_book",
      missingPriceComponents: [],
    },
    billedBy: "provider_cost" as const,
    skipReason: null,
  }));
  profileMocks.resolveModelGatewayProfile.mockImplementation(async () =>
    profileFor("chat"),
  );
  profileMocks.requireDefaultModelGatewayProfile.mockImplementation(
    async (kind: string) => profileFor(kind),
  );
  rawMocks.getRawModelGatewayClient.mockImplementation(async () =>
    fakeGateway(),
  );
});

async function buildContext() {
  const resolver = createDefaultDeliverableRuntimeResolver({
    feature: "deliverable",
  });
  const { ctx } = await resolver(JOB as never);
  return ctx;
}

function meterCalls() {
  return billingMocks.meterBillableModelUsage.mock.calls.map(
    ([call]) => call as Record<string, unknown>,
  );
}

test("chat completions settle under the stable job/operation/scope/seq key", async () => {
  const ctx = await buildContext();

  await ctx.llm.complete({
    messages: [{ role: "user", content: "hi" }],
    metadata: { stage: "plan_outline", slideNumber: 3 },
  } as never);
  await ctx.llm.complete({
    messages: [{ role: "user", content: "hi again" }],
    metadata: { stage: "plan_outline", slideNumber: 3 },
  } as never);

  assert.deepEqual(
    meterCalls().map((call) => call.idempotencyKey),
    [
      "job_1:deliverable.plan_outline:3:1",
      "job_1:deliverable.plan_outline:3:2",
    ],
  );
  assert.deepEqual(
    meterCalls().map((call) => call.referenceId),
    ["artifact_1", "artifact_1"],
  );
});

test("chat billing identity and metadata are preserved", async () => {
  const ctx = await buildContext();

  await ctx.llm.complete({
    messages: [{ role: "user", content: "hi" }],
    metadata: { stage: "draft_section" },
  } as never);

  const [call] = meterCalls();
  assert.equal(call?.operation, "deliverable.draft_section");
  assert.equal(call?.modelKind, "chat");
  assert.equal(call?.gatewayConfigId, "gw_chat");
  assert.equal(call?.profileAlias, "p_chat");
  assert.equal(call?.modelAlias, "m_chat");
  assert.equal(call?.teamId, "team_1");
  assert.equal(call?.actorUserId, "user_1");
  assert.equal(call?.feature, "deliverable");
  const metadata = call?.metadata as Record<string, unknown>;
  assert.equal(metadata.artifactId, "artifact_1");
  assert.equal(metadata.jobId, "job_1");
});

test("missing parsed structured output keeps STRUCTURED_OUTPUT retry metadata", async () => {
  const complete = vi.fn(async () => ({
    model: "m",
    usage: USAGE,
    raw: { content: "" },
  }));
  rawMocks.getRawModelGatewayClient.mockResolvedValue({
    ...fakeGateway(),
    chat: { complete },
  });
  const ctx = await buildContext();

  await assert.rejects(
    () =>
      ctx.llm.completeStructured({
        messages: [{ role: "user", content: "return structured data" }],
        metadata: { stage: "plan_outline" },
        schema: { type: "object" },
        schemaName: "report_outline",
      }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "STRUCTURED_OUTPUT");
      assert.equal((error as { retryable?: unknown }).retryable, true);
      return true;
    },
  );
  // One normal call plus the existing same-model tool nudge.
  assert.equal(complete.mock.calls.length, 2);
});

test("tts, vision and image each keep their own reserved operation key", async () => {
  const ctx = await buildContext();

  await ctx.tts?.speech({ text: "read this", metadata: { slideNumber: 2 } });
  await ctx.llm.completeVision?.({
    prompt: "describe",
    images: [{ data: new Uint8Array([1]), mimeType: "image/png" }],
    metadata: {},
  } as never);
  const firstImage = await ctx.image?.generate({
    prompt: "a cat",
    metadata: {},
  } as never);
  const secondImage = await ctx.image?.generate({
    prompt: "a dog",
    metadata: {},
  } as never);

  assert.ok(firstImage, "image generation should not silently fail");
  assert.ok(secondImage, "image generation should not silently fail");

  assert.deepEqual(
    meterCalls().map((call) => call.idempotencyKey),
    [
      "job_1:deliverable.tts:2:1",
      "job_1:deliverable.visual_qa:0:1",
      "job_1:deliverable.asset_image:0:1",
      // Second image reuses the memoised gateway, so the sequence advances
      // rather than restarting and colliding with the first key.
      "job_1:deliverable.asset_image:0:2",
    ],
  );
});
