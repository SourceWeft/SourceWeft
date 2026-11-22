import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { BillingAdmissionError } from "../../../shared/model-gateway/billing/admission";
import { ModelGatewayError } from "../../../shared/model-gateway/errors";
import { ContentError } from "../../content/errors";

const mocks = vi.hoisted(() => ({
  resolveProfile: vi.fn(),
  ensureConfig: vi.fn(),
  complete: vi.fn(),
  withBilled: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../../../shared/model-gateway/index", async () => ({
  BillingAdmissionError: (
    await vi.importActual<
      typeof import("../../../shared/model-gateway/billing/admission")
    >("../../../shared/model-gateway/billing/admission")
  ).BillingAdmissionError,
  ensureModelConfigAvailable: mocks.ensureConfig,
  resolveModelGatewayProfile: mocks.resolveProfile,
  withBilledModelGateway: mocks.withBilled,
}));
vi.mock("../../content/model-gateway-audit", () => ({
  recordGatewayOperationEvent: mocks.audit,
}));

import {
  assertYouTubeTranscriptionConfigured,
  createBilledVideoModelPort,
} from "./model-port";

const PROFILE = {
  gatewayConfigId: "gw-1",
  profileAlias: "youtube-transcript",
  modelAlias: "gemini-flash",
};
const billing = { id: "billing-port" } as never;
const portInput = {
  billing,
  teamId: "team-1",
  workspaceId: "ws-1",
  userId: "user-1",
  sourceId: "source-1",
  idempotencyKey: "source_parse_source-1_1",
};
const call = {
  prompt: "Transcribe",
  videoUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  maxOutputTokens: 65_536,
};

beforeEach(() => {
  mocks.resolveProfile.mockReset().mockResolvedValue(PROFILE);
  mocks.ensureConfig.mockReset().mockResolvedValue(undefined);
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.complete.mockReset().mockResolvedValue({
    raw: { content: "LANGUAGE: en\n[0:00] hi" },
    finishReason: "stop",
    provider: "openrouter",
    providerModel: "google/gemini-2.5-flash",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  mocks.withBilled
    .mockReset()
    .mockImplementation(async (_options, run) =>
      run({ chat: { complete: mocks.complete } }),
    );
});

test("resolves the youtube-transcript vision profile", async () => {
  await createBilledVideoModelPort(portInput);
  assert.deepEqual(mocks.resolveProfile.mock.calls[0]![0], {
    kind: "vision",
    requestedProfileAlias: "youtube-transcript",
    defaultRequired: false,
  });
});

test("bills ingestion.youtube with the youtube-transcript idempotency key", async () => {
  const port = await createBilledVideoModelPort(portInput);
  await port.complete(call);

  const [options] = mocks.withBilled.mock.calls[0]!;
  assert.equal(options.billing, billing);
  assert.equal(options.gatewayConfigId, "gw-1");
  assert.deepEqual(options.context, {
    teamId: "team-1",
    workspaceId: "ws-1",
    actorUserId: "user-1",
    feature: "ingestion.youtube",
    intent: { mode: "billed" },
    scopeKind: "worker-job",
    scopeId: "source-1",
  });

  const [, requestOptions] = mocks.complete.mock.calls[0]!;
  assert.equal(requestOptions.operation, "source.youtube_transcribe");
  assert.equal(requestOptions.modelKind, "vision");
  assert.equal(
    requestOptions.referenceId,
    "source:source-1:youtube-transcript",
  );
  assert.equal(
    requestOptions.idempotencyKey,
    "source_parse_source-1_1:youtube-transcript",
  );
  assert.equal(requestOptions.profileAlias, "youtube-transcript");
  assert.equal(requestOptions.modelAlias, "gemini-flash");
});

test("gives the transcription call a 15-minute timeout and no SDK retries", async () => {
  const port = await createBilledVideoModelPort(portInput);
  await port.complete(call);

  const [, requestOptions] = mocks.complete.mock.calls[0]!;
  assert.equal(requestOptions.timeoutMs, 900_000);
  assert.equal(requestOptions.maxRetries, 0);
});

test("sends a video_url part with thinking off and the output token budget", async () => {
  const port = await createBilledVideoModelPort(portInput);
  const result = await port.complete(call);

  const [request] = mocks.complete.mock.calls[0]!;
  assert.equal(request.model, "gemini-flash");
  assert.equal(request.maxTokens, 65_536);
  assert.deepEqual(request.thinking, {
    mode: "off",
    enabled: false,
    includeReasoning: false,
  });
  assert.deepEqual(request.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "Transcribe" },
        {
          type: "video_url",
          video_url: { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
        },
      ],
    },
  ]);
  assert.deepEqual(result, {
    text: "LANGUAGE: en\n[0:00] hi",
    finishReason: "stop",
    model: "google/gemini-2.5-flash",
  });
  assert.equal(mocks.audit.mock.calls.length, 1);
  assert.equal(mocks.audit.mock.calls[0]![0].success, true);
  assert.equal(
    mocks.audit.mock.calls[0]![0].operation,
    "source.youtube_transcribe",
  );
});

test("joins text blocks when the model answers with content blocks", async () => {
  mocks.complete.mockResolvedValue({
    raw: {
      content: [
        { type: "text", text: "LANGUAGE: en\n" },
        { type: "text", text: "[0:00] hi" },
      ],
    },
    finishReason: "length",
  });
  const port = await createBilledVideoModelPort(portInput);
  const result = await port.complete(call);
  assert.equal(result.text, "LANGUAGE: en\n[0:00] hi");
  assert.equal(result.finishReason, "length");
});

test("refuses to run without a billing port or payer", async () => {
  await assert.rejects(
    createBilledVideoModelPort({ ...portInput, billing: undefined as never }),
    /billing port/,
  );
  await assert.rejects(
    createBilledVideoModelPort({ ...portInput, userId: "" }),
    /userId/,
  );
  assert.equal(mocks.withBilled.mock.calls.length, 0);
});

test("an unconfigured profile is YOUTUBE_TRANSCRIPTION_NOT_CONFIGURED", async () => {
  mocks.resolveProfile.mockResolvedValue(null);
  for (const run of [
    () => assertYouTubeTranscriptionConfigured(),
    () => createBilledVideoModelPort(portInput),
  ]) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "YOUTUBE_TRANSCRIPTION_NOT_CONFIGURED");
      return true;
    });
  }
});

test("a provider 4xx saying the video is private is YOUTUBE_VIDEO_UNAVAILABLE", async () => {
  mocks.complete.mockRejectedValue(
    new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "The requested video is private or has been removed",
      statusCode: 400,
      provider: "openrouter",
    }),
  );
  const port = await createBilledVideoModelPort(portInput);
  await assert.rejects(port.complete(call), (error: unknown) => {
    assert.ok(error instanceof ContentError);
    assert.equal(error.statusCode, 422);
    assert.equal(error.code, "YOUTUBE_VIDEO_UNAVAILABLE");
    return true;
  });
  const failure = mocks.audit.mock.calls[0]![0];
  assert.equal(failure.success, false);
  assert.equal(failure.errorCode, "MODEL_REQUEST_INVALID");
});

for (const message of [
  "Requested URL not found",
  "File not found on upstream",
  "Media resource is unavailable",
]) {
  test(`a 4xx that names no video is YOUTUBE_TRANSCRIPT_FAILED (${message})`, async () => {
    mocks.complete.mockRejectedValue(
      new ModelGatewayError({
        code: "BAD_REQUEST",
        message,
        statusCode: 404,
      }),
    );
    const port = await createBilledVideoModelPort(portInput);
    await assert.rejects(port.complete(call), {
      code: "YOUTUBE_TRANSCRIPT_FAILED",
    });
  });
}

test("a 4xx saying the YouTube video was not found is YOUTUBE_VIDEO_UNAVAILABLE", async () => {
  mocks.complete.mockRejectedValue(
    new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "YouTube video not found",
      statusCode: 404,
    }),
  );
  const port = await createBilledVideoModelPort(portInput);
  await assert.rejects(port.complete(call), {
    code: "YOUTUBE_VIDEO_UNAVAILABLE",
  });
});

test("any other provider failure is YOUTUBE_TRANSCRIPT_FAILED", async () => {
  mocks.complete.mockRejectedValue(
    new ModelGatewayError({
      code: "UPSTREAM",
      message: "upstream exploded",
      statusCode: 500,
    }),
  );
  const port = await createBilledVideoModelPort(portInput);
  await assert.rejects(port.complete(call), (error: unknown) => {
    assert.ok(error instanceof ContentError);
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "YOUTUBE_TRANSCRIPT_FAILED");
    return true;
  });
});

test("a 4xx about the model rather than the video is YOUTUBE_TRANSCRIPT_FAILED", async () => {
  mocks.complete.mockRejectedValue(
    new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "No endpoints found for this model",
      statusCode: 404,
    }),
  );
  const port = await createBilledVideoModelPort(portInput);
  await assert.rejects(port.complete(call), {
    code: "YOUTUBE_TRANSCRIPT_FAILED",
  });
});

test("a billing refusal keeps its own code instead of becoming a transcript failure", async () => {
  const refusal = new BillingAdmissionError({
    allowed: false,
    reason: "insufficient_credits",
    availableCredits: 0,
    billingMode: "credits" as never,
  });
  mocks.withBilled.mockRejectedValue(refusal);
  const port = await createBilledVideoModelPort(portInput);
  await assert.rejects(port.complete(call), (error: unknown) => {
    assert.equal(error, refusal);
    return true;
  });
  assert.equal(mocks.audit.mock.calls[0]![0].success, false);
});
