import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeInvokedSkillIds } from "./invoked-skills";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { resolveRequestedThreadProfileAlias } from "./requested-profile-alias";
import { testExports } from "./preparer";

function skill(input: Partial<EnabledSkillDescriptor>): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "skill-1",
    sourceType: "builtin",
    name: "skill",
    version: "1.0.0",
    description: "Skill",
    files: [],
    ...input,
  };
}

test("normalizeInvokedSkillIds only keeps explicitly invoked enabled skills", () => {
  assert.deepEqual(
    normalizeInvokedSkillIds({
      enabledSkills: [
        skill({ workspaceSkillId: "builtin:ppt-deck", name: "ppt-deck" }),
        skill({
          workspaceSkillId: "builtin:image-generate",
          name: "image-generate",
        }),
      ],
      requestedSkillIds: [
        "builtin:image-generate",
        "missing-skill",
        "builtin:image-generate",
        42,
      ],
    }),
    ["builtin:image-generate"],
  );
});

test("normalizeInvokedSkillIds does not treat selected skills as invoked", () => {
  assert.deepEqual(
    normalizeInvokedSkillIds({
      enabledSkills: [
        skill({ workspaceSkillId: "builtin:ppt-deck", name: "ppt-deck" }),
        skill({
          workspaceSkillId: "builtin:image-generate",
          name: "image-generate",
        }),
      ],
      requestedSkillIds: undefined,
    }),
    [],
  );
});

test("resolveRequestedThreadProfileAlias prefers execution config over legacy stream modelSettings", () => {
  assert.deepEqual(
    resolveRequestedThreadProfileAlias({
      execution: { profileAlias: "global-image-profile" },
      legacyProfileAlias: "legacy-image-profile",
      kind: "image",
    }),
    { provided: true, profileAlias: "global-image-profile" },
  );
});

test("resolveRequestedThreadProfileAlias normalizes default aliases to inherited defaults", () => {
  assert.deepEqual(
    resolveRequestedThreadProfileAlias({
      execution: { profileAlias: "vision-default" },
      kind: "vision",
    }),
    { provided: true, profileAlias: null },
  );
});

test("resolveRequestedThreadProfileAlias ignores BYOK execution profile aliases", () => {
  assert.deepEqual(
    resolveRequestedThreadProfileAlias({
      execution: {
        executionMode: "BYOK",
        byokModelId: "byok-image-model",
        profileAlias: "global-image-profile",
      },
      kind: "image",
    }),
    { provided: false, profileAlias: undefined },
  );
});

/**
 * These two strings address ledger rows that may already exist. If either
 * changes, the next deploy re-meters every already-charged vision fallback and
 * bills those users a second time, so they are pinned character-for-character.
 */
test("vision fallback billing keys are pinned to their pre-migration form", () => {
  assert.equal(
    testExports.buildVisionFallbackIdempotencyKey({
      userMessageId: "message-1",
      imageId: "image-1",
    }),
    "vision-fallback:message-1:image-1",
  );
  assert.equal(
    testExports.buildVisionFallbackReferenceId({
      threadId: "thread-1",
      userMessageId: "message-1",
      imageId: "image-1",
    }),
    "thread:thread-1:message:message-1:image:image-1:vision-fallback",
  );
});

test("vision fallback preflight billing maps settled traces without re-metering", () => {
  const usage = { inputTokens: 11, outputTokens: 3, totalTokens: 14 };
  assert.deepEqual(
    testExports.buildVisionFallbackPreflightBilling({
      items: [
        {
          imageId: "image-1",
          imageFileName: "receipt.png",
          gatewayConfigId: "gateway-1",
          profileAlias: "vision-profile",
          modelAlias: "vision-model",
          usage,
          provider: "openrouter",
          providerModel: "openrouter/vision-model",
          billingMetadata: {
            traceId: "trace-1",
            threadId: "thread-1",
            messageId: "message-1",
            imageId: "image-1",
            imageFileName: "receipt.png",
            chatModelAlias: "chat-model",
          },
          meteredCall: {
            id: "vision-fallback:message-1:image-1",
            operation: "chat.vision_fallback",
            modelKind: "vision",
            modelAlias: "vision-model",
            profileAlias: "vision-profile",
            gatewayConfigId: "gateway-1",
            usage,
            billingStatus: "metered",
            consumedCredits: 4,
            billedBy: "provider_cost",
            skipReason: null,
            idempotencyKey: "vision-fallback:message-1:image-1",
            referenceId:
              "thread:thread-1:message:message-1:image:image-1:vision-fallback",
            providerCostUsd: 0.004,
            pricingSnapshot: { input: 1 },
            billing: {
              teamId: "team-1",
              availableCredits: 96,
              consumedThisCycle: 4,
              idempotencyReplayed: false,
            },
          },
        },
        // Settlement returns nothing when the provider reported no usage, so
        // there is no charge and nothing to report.
        {
          imageId: "image-2",
          imageFileName: "diagram.png",
          gatewayConfigId: "gateway-1",
          profileAlias: "vision-profile",
          modelAlias: "vision-model",
          billingMetadata: {},
          meteredCall: null,
        },
      ],
    }),
    [
      {
        id: "image-1",
        operation: "chat.vision_fallback",
        modelKind: "vision",
        modelAlias: "vision-model",
        profileAlias: "vision-profile",
        consumedCredits: 4,
        billedBy: "provider_cost",
        skipReason: null,
        usage,
        metadata: {
          traceId: "trace-1",
          threadId: "thread-1",
          messageId: "message-1",
          imageId: "image-1",
          imageFileName: "receipt.png",
          chatModelAlias: "chat-model",
          provider: "openrouter",
          providerModel: "openrouter/vision-model",
          routeDecision: null,
          idempotencyReplayed: false,
          providerCostUsd: 0.004,
          pricingSnapshot: { input: 1 },
        },
      },
    ],
  );
});

test("step-summary failure resumes its saved checkpoint while error text stays excluded", () => {
  const stop = {
    reason: "step_limit",
    steps: 400,
    limit: 400,
    canContinue: true,
    summaryStatus: "failed",
  };
  const previous = {
    id: "old",
    role: "assistant",
    metadata: {
      agentCheckpoint: {
        final: { threadId: "thread-1", checkpointId: "old-checkpoint" },
      },
    },
  };
  const failed = {
    id: "failed",
    role: "assistant",
    metadata: {
      excludeFromContext: true,
      isError: true,
      agentRunStop: stop,
      agentCheckpoint: {
        final: { threadId: "thread-1", checkpointId: "saved-progress" },
      },
    },
  };
  const select = (messages: unknown[]) =>
    testExports.resolveLatestAssistantFinalCheckpoint(messages as never);
  assert.deepEqual(select([previous, failed]), {
    threadId: "thread-1",
    checkpointId: "saved-progress",
  });
  assert.deepEqual(
    select([
      previous,
      { ...failed, metadata: { ...failed.metadata, agentRunStop: null } },
    ]),
    { threadId: "thread-1", checkpointId: "old-checkpoint" },
  );
  assert.deepEqual(
    select([
      previous,
      { ...failed, metadata: { ...failed.metadata, isCancelled: true } },
    ]),
    { threadId: "thread-1", checkpointId: "old-checkpoint" },
  );
  assert.throws(
    () =>
      select([
        previous,
        {
          ...failed,
          metadata: { ...failed.metadata, agentCheckpoint: { final: null } },
        },
      ]),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "AGENT_STEP_CONTINUATION_UNAVAILABLE",
  );
});

test("a continued message carries its citation registry and the ids its text cites", () => {
  const citation = (key: string, chunkId: string) => ({
    citation: key,
    sourceId: null,
    sourceTitle: key,
    documentId: null,
    chunkId,
    score: 1,
    excerpt: key,
    quoteText: key,
    origin: "web_fetch",
    externalUri: `https://example.com/${chunkId}`,
  });
  const continuation = testExports.resolveTraceContinuationMetadata({
    id: "assistant",
    role: "assistant",
    content: "Revenue grew [citation:c2], led by exports [citation:c3].",
    metadata: {
      retrieval: {
        // A paused turn finalizes with no used citations.
        citations: [],
        availableCitations: [
          citation("c1", "a"),
          citation("c2", "b"),
          citation("c3", "c"),
          { citation: "c4" },
        ],
      },
    },
  } as never);
  assert.deepEqual(
    continuation?.citations?.map((item) => item.citation),
    ["c1", "c2", "c3"],
  );
  assert.deepEqual(continuation?.citedCitationKeys, ["c2", "c3"]);
  assert.equal(
    testExports.resolveTraceContinuationMetadata({
      id: "assistant",
      role: "assistant",
      content: "",
      metadata: {},
    } as never),
    null,
  );
});
