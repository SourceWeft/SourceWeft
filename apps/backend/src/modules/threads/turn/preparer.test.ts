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
