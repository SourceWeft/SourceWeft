import assert from "node:assert/strict";
import { test } from "vitest";
import {
  presentGeneration,
  presentGenerationSummary,
  presentSpan,
  presentTraceSummary,
} from "./presenter";
import type { LlmObservabilityAccess } from "./permissions";

const access: LlmObservabilityAccess = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  actorUserId: "user-1",
  role: "workspace_admin",
  payloadAccess: true,
  metricsOnly: false,
};

const noPayloadAccess: LlmObservabilityAccess = {
  ...access,
  role: "billing_admin",
  payloadAccess: false,
  metricsOnly: true,
};

test("presentGeneration redacts payload fields without payload access", () => {
  const presented = presentGeneration(
    {
      id: "generation-1",
      inputJson: { prompt: "secret prompt" },
      outputJson: { text: "secret output" },
      outputText: "secret output",
      reasoningText: "private reasoning",
      providerFieldsJson: { raw: true },
      providerRequestJson: { body: true },
      providerResponseJson: { body: true },
      providerRequestHeadersJson: { authorization: "redacted" },
      providerResponseHeadersJson: { requestId: "req-1" },
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
      startedAt: new Date(0),
      endedAt: null,
    },
    noPayloadAccess,
  );

  assert.deepEqual(presented.input, {
    redacted: true,
    reason: "insufficient_permission",
  });
  assert.deepEqual(presented.output, {
    redacted: true,
    reason: "insufficient_permission",
  });
  assert.deepEqual(presented.providerRequest, {
    redacted: true,
    reason: "insufficient_permission",
  });
  assert.equal(presented.promptTokens, 4);
  assert.equal(presented.completionTokens, 5);
  assert.equal(presented.totalTokens, 9);
});

test("presentGenerationSummary omits payload fields", () => {
  const summary = presentGenerationSummary({
    id: "generation-1",
    inputJson: { prompt: "should not appear" },
    outputJson: { text: "should not appear" },
    outputText: "should not appear",
    usageJson: { totalTokens: 3 },
    startedAt: new Date(0),
    endedAt: null,
  });

  assert.equal("input" in summary, false);
  assert.equal("output" in summary, false);
  assert.equal("outputText" in summary, false);
  assert.deepEqual(summary.usage, { totalTokens: 3 });
  assert.equal(summary.totalTokens, undefined);
  assert.equal(summary.usageDetails.totalTokens, 3);
});

test("presentGeneration exposes explicit model routing fields", () => {
  const presented = presentGeneration(
    {
      id: "generation-1",
      modelAlias: "chat-default",
      providerModel: "minimax/minimax-m2.7",
      routeDecisionJson: { provider: "openrouter", alias: "chat-default" },
      keySource: "rawApiKey",
      metadataJson: {
        modelAlias: "chat-default",
        providerModel: "minimax/minimax-m2.7",
        routeDecision: { provider: "openrouter" },
        providerHint: "openrouter",
        observationName: "chat.answer",
      },
      startedAt: new Date(0),
      endedAt: null,
    },
    access,
  );

  assert.equal(presented.model, "chat-default");
  assert.equal(presented.modelAlias, "chat-default");
  assert.equal(presented.providerModel, null);
  assert.equal(presented.keySource, "rawApiKey");
  assert.deepEqual(presented.routeDecision, {
    provider: "openrouter",
    alias: "chat-default",
  });
  assert.deepEqual(presented.metadata, {
    modelAlias: "chat-default",
    providerModel: "minimax/minimax-m2.7",
    routeDecision: { provider: "openrouter" },
    providerHint: "openrouter",
    observationName: "chat.answer",
  });
});

test("presentGeneration uses observation operation for semantic display", () => {
  const presented = presentGeneration(
    {
      id: "generation-1",
      operation: "chat.complete",
      metadataJson: {
        observationOperation: "chat.title",
      },
      startedAt: new Date(0),
      endedAt: null,
    },
    access,
  );

  assert.equal(presented.operation, "chat.title");
  assert.equal(presented.gatewayOperation, "chat.complete");
});

test("presentTraceSummary exposes error status message", () => {
  const summary = presentTraceSummary({
    id: "trace-row-1",
    traceId: "trace-1",
    status: "error",
    errorCode: "MODEL_ERROR",
    errorMessage: "Provider rejected the request",
    startedAt: new Date(0),
    endedAt: null,
  });

  assert.equal(summary.level, "ERROR");
  assert.equal(summary.statusMessage, "Provider rejected the request");
  assert.equal(summary.errorMessage, "Provider rejected the request");
});

test("presentGeneration hides payloads blocked by payload policy", () => {
  const presented = presentGeneration(
    {
      inputJson: { mode: "metadata_only", sha256: "abc" },
      outputJson: { mode: "preview", preview: "visible preview" },
      startedAt: new Date(),
      endedAt: null,
    },
    access,
  );

  assert.deepEqual(presented.input, {
    redacted: true,
    reason: "payload_policy",
  });
  assert.deepEqual(presented.output, {
    mode: "preview",
    preview: "visible preview",
  });
});

test("presentGeneration hides payloads after full payload retention", () => {
  const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const presented = presentGeneration(
    {
      inputJson: { mode: "full", value: { prompt: "expired" } },
      outputJson: { mode: "preview", preview: "still visible" },
      startedAt: oldDate,
      endedAt: null,
    },
    access,
  );

  assert.deepEqual(presented.input, {
    redacted: true,
    reason: "retention_expired",
  });
  assert.deepEqual(presented.output, {
    mode: "preview",
    preview: "still visible",
  });
});

test("presentSpan redacts tool payload fields without payload access", () => {
  const presented = presentSpan(
    {
      inputJson: { query: "private" },
      outputJson: { result: "private" },
      startedAt: new Date(0),
      endedAt: null,
    },
    noPayloadAccess,
  );

  assert.deepEqual(presented.input, {
    redacted: true,
    reason: "insufficient_permission",
  });
  assert.deepEqual(presented.output, {
    redacted: true,
    reason: "insufficient_permission",
  });
});
