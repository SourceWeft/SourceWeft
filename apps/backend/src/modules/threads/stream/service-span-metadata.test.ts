import assert from "node:assert/strict";
import { test } from "vitest";
import { buildGatewayRequestMetadata } from "../../content/model-gateway-audit";
import {
  createCitation,
  createStreamPreparedTurn,
  createTurnOutcome,
} from "../../../test/thread-stream-fixtures";
import { buildAgentRunSpanMetadata, buildAgentRunSpanOutput } from "./service";

const outcome = createTurnOutcome();
const citation = createCitation();
const prepared = createStreamPreparedTurn();

test("buildAgentRunSpanOutput includes reasoning and usage", () => {
  assert.deepEqual(
    buildAgentRunSpanOutput({
      ...outcome,
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 3,
      },
      reasoning: "Used the invoice total from the retrieved source.",
      thinkingSteps: [
        {
          id: "reasoning-summary",
          kind: "reasoning_summary",
          title: "Reasoning summary",
          status: "completed",
          items: [],
          sequence: 0,
          description: "Used the invoice total from the retrieved source.",
        },
      ],
      reasoningSegments: [
        {
          id: "model-reasoning-1",
          text: "Used the invoice total from the retrieved source.",
          sequence: 0,
        },
      ],
    }),
    {
      assistantContent: "Answer",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 3,
      },
      reasoning: "Used the invoice total from the retrieved source.",
      reasoningSegments: [
        {
          id: "model-reasoning-1",
          index: 0,
          sequence: 0,
          phase: "initial",
          text: {
            preview: "Used the invoice total from the retrieved source.",
            length: 49,
            truncated: false,
          },
        },
      ],
      toolCallCount: 0,
      retrievalCallCount: 0,
      citationCount: 0,
      availableCitationCount: 0,
      citations: [],
      availableCitations: [],
      thinkingStepCount: 1,
      renderBlockCount: 0,
      reasoningSegmentCount: 1,
    },
  );
});

test("buildAgentRunSpanOutput includes citation evidence summaries", () => {
  const output = buildAgentRunSpanOutput({
    ...outcome,
    citations: [citation],
    availableCitations: [
      citation,
      {
        ...citation,
        citation: "c2",
        chunkId: "chunk-2",
        chunkNo: 1,
        origin: "read_file",
        path: "/kb/invoice.md",
        excerpt: "x".repeat(500),
        quoteText: "y".repeat(500),
      },
    ],
  });

  assert.equal(output.citationCount, 1);
  assert.equal(output.availableCitationCount, 2);
  assert.deepEqual(output.citations, [
    {
      citation: "c1",
      rank: 1,
      sourceId: "source-1",
      sourceTitle: "invoice.pdf",
      documentId: "document-1",
      chunkId: "chunk-1",
      chunkNo: 0,
      origin: "search_sources",
      score: 0.95,
      excerpt: {
        preview: "Invoice total is 50.",
        length: 20,
        truncated: false,
      },
      quoteText: {
        preview: "Invoice total is 50.",
        length: 20,
        truncated: false,
      },
    },
  ]);

  const available = output.availableCitations as Array<Record<string, unknown>>;
  assert.equal(available.length, 2);
  assert.equal(available[1]?.path, "/kb/invoice.md");
  assert.deepEqual(available[1]?.excerpt, {
    preview: "x".repeat(320),
    length: 500,
    truncated: true,
  });
  assert.deepEqual(available[1]?.quoteText, {
    preview: "y".repeat(400),
    length: 500,
    truncated: true,
  });
});

test("buildAgentRunSpanMetadata includes thinking settings", () => {
  assert.deepEqual(
    buildAgentRunSpanMetadata({
      ...prepared,
      llm: {
        executionMode: "GLOBAL",
        thinking: {
          mode: "effort",
          enabled: true,
          effort: "high",
          includeReasoning: true,
        },
      },
    }),
    {
      mode: "continue",
      modelAlias: "test-model",
      profileAlias: "test-profile",
      gateway: {
        executionMode: "GLOBAL",
        providerHint: null,
        byokProvider: null,
        thinkingMode: "effort",
        thinkingEnabled: true,
        thinkingEffort: "high",
        thinkingIncludeReasoning: true,
        keySource: "global",
        provider: null,
        routeStrategy: null,
      },
      selectedSkillCount: 0,
    },
  );
});

test("buildAgentRunSpanMetadata uses BYOK identity over catalog profile", () => {
  assert.deepEqual(
    buildAgentRunSpanMetadata({
      ...prepared,
      llm: {
        executionMode: "BYOK",
        providerHint: "openrouter",
        byokModelId: "byok-model-1",
        credentialId: "credential-1",
        modelAlias: "openai/gpt-4o",
        providerModel: "openai/gpt-4o",
        byok: {
          provider: "openrouter",
          apiKey: "test-key",
        },
      },
    }),
    {
      mode: "continue",
      modelAlias: "byok:openrouter:openai/gpt-4o",
      profileAlias: null,
      catalogModelAlias: "test-model",
      gateway: {
        executionMode: "BYOK",
        providerHint: "openrouter",
        byokProvider: "openrouter",
        byokModelId: "byok-model-1",
        credentialId: "credential-1",
        thinkingMode: null,
        thinkingEnabled: false,
        thinkingEffort: null,
        thinkingIncludeReasoning: null,
        keySource: "byokCredential",
        provider: null,
        routeStrategy: null,
      },
      selectedSkillCount: 0,
    },
  );
});

test("buildGatewayRequestMetadata keeps BYOK profileAlias out of observed metadata", () => {
  const metadata = buildGatewayRequestMetadata({
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    threadId: "thread-1",
    messageId: "message-1",
    feature: "chat",
    operation: "chat.complete",
    modelAlias: "catalog-model",
    profileAlias: "global-profile",
    modelKind: "chat",
    llm: {
      executionMode: "BYOK",
      providerHint: "openrouter",
      byokModelId: "byok-model-1",
      credentialId: "credential-1",
      modelAlias: "openai/gpt-4o",
      providerModel: "openai/gpt-4o",
      byok: {
        provider: "openrouter",
        apiKey: "test-key",
      },
    },
  });

  assert.equal(metadata.profileAlias, null);
  assert.equal(metadata.catalogProfileAlias, undefined);
  assert.equal(metadata.modelAlias, "byok:openrouter:openai/gpt-4o");
  assert.equal(metadata.catalogModelAlias, "catalog-model");
  assert.equal(metadata.byokModelId, "byok-model-1");
  assert.equal(metadata.credentialId, "credential-1");
  assert.equal(metadata.providerModel, "openai/gpt-4o");
  assert.equal(metadata.keySource, "byokCredential");
});
