import assert from "node:assert/strict";
import test from "node:test";
import type { MeterConsumeRequest } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../billing-port";
import { testExports } from "./preparer";
import { testExports as inputTestExports } from "../stream/input";

function billingSummary() {
  return {
    teamId: "team-1",
    planFamily: "individual_free",
    billingMode: "enforced",
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
      monthlyGrant: 100,
      monthlyBalance: 100,
      addOnBalance: 0,
      reserved: 0,
      consumedThisCycle: 0,
      available: 100,
    },
    seats: {
      used: 1,
      limit: 1,
      remaining: 0,
    },
    spendLimits: {
      softCapUsd: null,
      hardCapUsd: null,
    },
  } satisfies Awaited<ReturnType<ContentBillingPort["getSummary"]>>;
}

test("buildVisionFallbackGatewayMetadata marks system vision fallback operation", () => {
  const metadata =
    testExports.buildVisionFallbackGatewayMetadata({
      workspace: {
        id: "workspace-1",
        organizationId: "team-1",
        name: "Workspace",
        slug: "workspace",
        createdBy: "user-1",
        createdAt: new Date(0).toISOString(),
      },
      threadId: "thread-1",
      userId: "user-1",
      traceId: "trace-1",
      messageId: "message-1",
      modelAlias: "vision-default",
      profileAlias: "vision-profile",
    });

  assert.deepEqual(metadata, {
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    threadId: "thread-1",
    messageId: "message-1",
    feature: "chat",
    operation: testExports.VISION_FALLBACK_DESCRIPTION_OPERATION,
    modelKind: "vision",
    modelAlias: "vision-default",
    profileAlias: "vision-profile",
    traceId: "trace-1",
  });
});

test("meterVisionFallbackBilling records traceable vision fallback credit usage", async () => {
  let consumeInput: MeterConsumeRequest | undefined;
  const billing: ContentBillingPort = {
    async getSummary() {
      return billingSummary();
    },
    async meterConsume(_teamId, input) {
      consumeInput = input;
      return {
        teamId: "team-1",
        consumedCredits: 2,
        availableCredits: 98,
        consumedThisCycle: 2,
        idempotencyReplayed: false,
      };
    },
    async meterIngestion() {
      return {
        teamId: "team-1",
        pagesConsumed: 0,
        pagesUsed: 0,
        pagesRemaining: 0,
        idempotencyReplayed: false,
      };
    },
  };

  const traces = await testExports.meterVisionFallbackBilling({
    billing,
    workspace: {
      id: "workspace-1",
      organizationId: "team-1",
      name: "Workspace",
      slug: "workspace",
      createdBy: "user-1",
      createdAt: new Date(0).toISOString(),
    },
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "message-1",
    traceId: "trace-1",
    chatModelAlias: "chat-default",
    meterUsage: async (input) => {
      await input.billing.getSummary(input.teamId);
      const billingResult = await input.billing.meterConsume(
        input.teamId,
        {
          workspaceId: input.workspaceId,
          feature: input.feature,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
          credits: 1,
          modelKind: input.modelKind,
          operation: input.operation,
          metadata: {
            billedBy: "minimum_credit",
            minimumCredits: 1,
            modelAlias: input.modelAlias ?? null,
            profileAlias: input.profileAlias,
            pricingSnapshot: null,
            providerCostUsd: 0,
            minimumCreditReason: "missing_or_zero_price",
            ...(input.metadata ?? {}),
          },
        },
        input.actorUserId,
      );
      return {
        billing: billingResult,
        cost: {
          providerCostUsd: 0,
          pricingSnapshot: null,
        },
        billedBy: "minimum_credit",
        skipReason: null,
      };
    },
    items: [
      {
        imageId: "image-1",
        imageFileName: "image.png",
        gatewayConfigId: "gateway-1",
        profileAlias: "vision-profile",
        modelAlias: "vision-default",
        usage: {
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
        },
        provider: "openrouter",
        providerModel: "google/gemini-flash",
        routeDecision: {
          alias: "vision-default",
          mode: "GLOBAL",
          strategy: "priority",
          provider: "openrouter",
          providerKind: "openrouter",
        },
      },
    ],
  });

  assert.equal(consumeInput?.feature, "chat");
  assert.equal(
    consumeInput?.operation,
    testExports.CHAT_VISION_FALLBACK_OPERATION,
  );
  assert.equal(consumeInput?.modelKind, "vision");
  assert.equal(
    consumeInput?.referenceId,
    "thread:thread-1:message:message-1:image:image-1:vision-fallback",
  );
  assert.equal(
    consumeInput?.idempotencyKey,
    "vision-fallback:message-1:image-1",
  );
  assert.deepEqual(consumeInput?.metadata, {
    billedBy: "minimum_credit",
    minimumCredits: 1,
    modelAlias: "vision-default",
    profileAlias: "vision-profile",
    pricingSnapshot: null,
    providerCostUsd: 0,
    minimumCreditReason: "missing_or_zero_price",
    traceId: "trace-1",
    threadId: "thread-1",
    messageId: "message-1",
    imageId: "image-1",
    imageFileName: "image.png",
    chatModelAlias: "chat-default",
    provider: "openrouter",
    providerModel: "google/gemini-flash",
    routeDecision: {
      alias: "vision-default",
      mode: "GLOBAL",
      strategy: "priority",
      provider: "openrouter",
      providerKind: "openrouter",
    },
  });
  assert.deepEqual(traces, [
    {
      id: "image-1",
      operation: testExports.CHAT_VISION_FALLBACK_OPERATION,
      modelKind: "vision",
      modelAlias: "vision-default",
      profileAlias: "vision-profile",
      consumedCredits: 2,
      billedBy: "minimum_credit",
      skipReason: null,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
      },
      metadata: {
        traceId: "trace-1",
        threadId: "thread-1",
        messageId: "message-1",
        imageId: "image-1",
        imageFileName: "image.png",
        chatModelAlias: "chat-default",
        provider: "openrouter",
        providerModel: "google/gemini-flash",
        routeDecision: {
          alias: "vision-default",
          mode: "GLOBAL",
          strategy: "priority",
          provider: "openrouter",
          providerKind: "openrouter",
        },
        idempotencyReplayed: false,
        providerCostUsd: 0,
        pricingSnapshot: null,
      },
    },
  ]);
});

test("edit stream input distinguishes omitted images from explicit images", () => {
  assert.equal(
    inputTestExports.shouldUseSubmittedEditImages({
      images: undefined,
      imagesProvided: false,
    }),
    false,
  );
  assert.equal(
    inputTestExports.shouldUseSubmittedEditImages({
      images: [],
      imagesProvided: true,
    }),
    true,
  );
  assert.equal(
    inputTestExports.shouldUseSubmittedEditImages({
      images: [{ dataUrl: "data:image/png;base64,aW1hZ2U=" }],
      imagesProvided: true,
    }),
    true,
  );
});
