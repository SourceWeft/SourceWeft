import assert from "node:assert/strict";
import { vi } from "vitest";
import type { BillingMode } from "@sourceweft/contracts";
import type { PreparedThreadTurn } from "../modules/threads";
import type {
  AgentCitation,
  DeepAgentTurnOutcome,
} from "../modules/threads/agent";
import {
  adaptBillingTestPort,
  type LegacyBillingTestPort,
} from "./billing-runtime";
import { createPreparedThreadTurn } from "./prepared-turn";

/**
 * Fixtures shared by the thread stream tests (`stream/service.test.ts`,
 * `stream/service-span-metadata.test.ts`, `stream/event-mapper.test.ts`) and
 * the title-generation test, which bills through the same port shape.
 */

/** Parses one `data: {...}` SSE frame; fails the test on anything else. */
export function parseSseData(value: string | null) {
  assert.notEqual(value, null);
  assert.equal(value!.startsWith("data: "), true);
  return JSON.parse(value!.slice("data: ".length).trim()) as Record<
    string,
    unknown
  >;
}

/**
 * A recording billing port over a fixed summary. Billing is disabled with no
 * credits unless a test says otherwise; only the fields admission reads are
 * configurable.
 */
export function createBillingPort(
  input: { billingMode?: BillingMode; availableCredits?: number } = {},
): LegacyBillingTestPort {
  return adaptBillingTestPort({
    getSummary: vi.fn(async (teamId: string) => ({
      teamId,
      planFamily: "individual_free",
      billingMode: input.billingMode ?? "disabled",
      cycleAnchorAt: new Date(0).toISOString(),
      cycleSource: "free_account",
      cycleStartAt: new Date(0).toISOString(),
      cycleEndAt: new Date(0).toISOString(),
      pages: {
        limit: 0,
        used: 0,
        remaining: 0,
        monthlyGrant: 0,
        monthlyBalance: 0,
        addOnBalance: 0,
        consumedThisCycle: 0,
        available: 0,
      },
      credits: {
        monthlyGrant: 0,
        monthlyBalance: 0,
        addOnBalance: 0,
        reserved: 0,
        consumedThisCycle: 0,
        available: input.availableCredits ?? 0,
      },
      seats: {
        used: 0,
        limit: 0,
        remaining: 0,
        activeMembers: 0,
        pendingInvitations: 0,
      },
      spendLimits: {
        softCapUsd: null,
        hardCapUsd: null,
      },
    })),
    meterConsume: vi.fn(async (teamId: string) => ({
      teamId,
      consumedCredits: 0,
      availableCredits: 0,
      consumedThisCycle: 0,
      idempotencyReplayed: false,
    })),
    meterIngestion: vi.fn(async (teamId: string) => ({
      teamId,
      pagesConsumed: 0,
      pagesUsed: 0,
      pagesRemaining: 0,
      idempotencyReplayed: false,
    })),
  }) as unknown as LegacyBillingTestPort;
}

/** A finished turn that answered "Answer" with no tools, citations or steps. */
export function createTurnOutcome(): DeepAgentTurnOutcome {
  return {
    assistantContent: "Answer",
    retrieval: null,
    citations: [],
    availableCitations: [],
    retrievalCalls: [],
    toolCalls: [],
    thinkingSteps: [],
    reasoningSegments: [],
    agentCheckpoint: {
      beforeInput: null,
      beforeAssistant: null,
      resume: null,
      final: null,
    },
  };
}

/** One search_sources citation of an invoice chunk. */
export function createCitation(): AgentCitation {
  return {
    citation: "c1",
    sourceId: "source-1",
    sourceTitle: "invoice.pdf",
    documentId: "document-1",
    chunkId: "chunk-1",
    chunkNo: 0,
    score: 0.95,
    excerpt: "Invoice total is 50.",
    quoteText: "Invoice total is 50.",
    origin: "search_sources" as const,
  };
}

/**
 * The prepared turn the stream service tests run: user-1 asking about an
 * invoice on private thread-1 in workspace-1 of team-1, traced as
 * user-message-1.
 */
export function createStreamPreparedTurn(): PreparedThreadTurn {
  return createPreparedThreadTurn({
    reasoningRun: { runId: "stream-test", parentRunId: null, base: "" },
    sourceSelectionRevision: 0,
    userId: "user-1",
    workspace: {
      id: "workspace-1",
      organizationId: "team-1",
    } as PreparedThreadTurn["workspace"],
    thread: {
      id: "thread-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      title: "New chat",
      modelSettings: {
        llmProfileAlias: null,
        imageProfileAlias: null,
        visionProfileAlias: null,
        llmModelAlias: null,
        imageModelAlias: null,
        visionModelAlias: null,
      },
      chatPreferences: {
        thinking: { mode: "auto", effort: "medium" },
        webAccess: true,
        composerOptions: {},
      },
      sourceCount: 0,
      visibility: "private",
      parentThreadId: null,
      personaId: null,
      origin: "user",
      createdBy: "user-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastMessageAt: null,
    },
    messageContent: "What is in this invoice?",
    messageContentJson: {
      version: 1,
      parts: [{ type: "text", text: "What is in this invoice?" }],
    },
    agentMessageContent: "What is in this invoice?",
    runTraceId: "user-message-1",
    userMessage: {
      id: "user-message-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      parentMessageId: null,
      role: "user",
      content: "What is in this invoice?",
      contentJson: {},
      metadata: {},
      createdAt: new Date(0).toISOString(),
      createdBy: "user-1",
      model: null,
      creditsConsumed: null,
    },
    assistantMessageIdOverride: null,
    providerModel: "test-model",
    chatProfile: {
      gatewayConfigId: "gateway-1",
    } as PreparedThreadTurn["chatProfile"],
    llmIdempotencyKey: "thread-stream:user-message-1:assistant",
    agentRunThreadId: "thread-1",
    initialTitle: "New chat",
  } satisfies Partial<PreparedThreadTurn>);
}
