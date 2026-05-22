import assert from "node:assert/strict";
import { test } from "vitest";
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
      activeMembers: 1,
      pendingInvitations: 0,
    },
    spendLimits: {
      softCapUsd: null,
      hardCapUsd: null,
    },
  } satisfies Awaited<ReturnType<ContentBillingPort["getSummary"]>>;
}

test("buildVisionFallbackGatewayMetadata marks system vision fallback operation", () => {
  const metadata = testExports.buildVisionFallbackGatewayMetadata({
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
          costSource: "missing_or_zero_price",
          missingPriceComponents: [],
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

test("stream input metadata helper rejects arrays", () => {
  assert.deepEqual(
    inputTestExports.getMessageMetadataRecord({
      metadata: {
        finishReason: "tool_confirmation_requested",
      },
    }),
    {
      finishReason: "tool_confirmation_requested",
    },
  );
  assert.deepEqual(
    inputTestExports.getMessageMetadataRecord({
      metadata: ["tool_confirmation_requested"],
    }),
    {},
  );
});

test("tool confirmation refresh prefers the HITL resume checkpoint", () => {
  const state = inputTestExports.resolveToolConfirmationRefreshAgentState({
    finishReason: "tool_confirmation_requested",
    toolApprovalResume: {
      decisions: [{ type: "approve" }],
    },
    checkpoint: {
      beforeInput: {
        threadId: "thread-1",
        checkpointId: "before-input",
      },
      beforeAssistant: {
        threadId: "thread-1",
        checkpointId: "before-assistant",
      },
      resume: {
        threadId: "thread-1",
        checkpointId: "resume",
      },
      final: {
        threadId: "thread-1",
        checkpointId: "final",
      },
    },
  });

  assert.equal(state.agentMode, "replay");
  assert.deepEqual(state.agentBaseCheckpoint, {
    threadId: "thread-1",
    checkpointId: "resume",
  });
});

test("tool confirmation refresh requires resume decisions", () => {
  assert.throws(
    () =>
      inputTestExports.resolveToolConfirmationRefreshAgentState({
        finishReason: "tool_confirmation_requested",
        checkpoint: {
          beforeInput: {
            threadId: "thread-1",
            checkpointId: "before-input",
          },
          beforeAssistant: {
            threadId: "thread-1",
            checkpointId: "before-assistant",
          },
          resume: null,
          final: {
            threadId: "thread-1",
            checkpointId: "final",
          },
        },
      }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "THREAD_CONFIRMATION_RESUME_REQUIRED",
  );
});

test("tool confirmation refresh requires an interrupt checkpoint", () => {
  assert.throws(
    () =>
      inputTestExports.resolveToolConfirmationRefreshAgentState({
        finishReason: "tool_confirmation_requested",
        toolApprovalResume: {
          decisions: [{ type: "approve" }],
        },
        checkpoint: null,
      }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "THREAD_CONFIRMATION_CHECKPOINT_MISSING",
  );
});

test("normal refresh still forks from before-input checkpoint", () => {
  const state = inputTestExports.resolveToolConfirmationRefreshAgentState({
    finishReason: "stop",
    checkpoint: {
      beforeInput: {
        threadId: "thread-1",
        checkpointId: "before-input",
      },
      beforeAssistant: {
        threadId: "thread-1",
        checkpointId: "before-assistant",
      },
      resume: null,
      final: {
        threadId: "thread-1",
        checkpointId: "final",
      },
    },
  });

  assert.equal(state.agentMode, "fork");
  assert.deepEqual(state.agentBaseCheckpoint, {
    threadId: "thread-1",
    checkpointId: "before-input",
  });
});

test("empty thread message validation allows submitted images", () => {
  assert.equal(
    testExports.shouldRejectEmptyThreadMessage({
      messageContent: "",
      images: [{ dataUrl: "data:image/png;base64,aW1hZ2U=" }],
    }),
    false,
  );
});

test("empty thread message validation allows existing image parts", () => {
  assert.equal(
    testExports.shouldRejectEmptyThreadMessage({
      messageContent: "",
      existingImageParts: [
        {
          type: "image",
          id: "image-1",
          fileName: "image.png",
          mimeType: "image/png",
          sizeBytes: 5,
          storageKey: "workspaces/workspace-1/images/image-1.png",
          url: "https://example.com/image.png",
        },
      ],
    }),
    false,
  );
});

test("empty thread message validation rejects textless imageless messages", () => {
  assert.equal(
    testExports.shouldRejectEmptyThreadMessage({
      messageContent: "",
      images: [],
    }),
    true,
  );
});

test("parseRequestedCommand ignores plain slash text without a structured command", () => {
  assert.equal(
    testExports.parseRequestedCommand({
      content: "/generate_image neon dashboard",
    } as Parameters<typeof testExports.parseRequestedCommand>[0]),
    null,
  );
  assert.deepEqual(
    testExports.parseRequestedCommand({
      command: {
        arguments: "neon dashboard",
        kind: "tool",
        name: "/generate_image",
      },
    }),
    {
      arguments: "neon dashboard",
      kind: "tool",
      name: "/generate_image",
    },
  );
  assert.equal(testExports.resolveToolCommandName("/image"), null);
});

test("parsePromptMarkers removes command markers and keeps source mentions in clean content", () => {
  assert.deepEqual(
    testExports.parsePromptMarkers(
      "[skills:feynman](Feynman) hi [source:source-1](Hacker News) [tool:generate_image](Generate image)",
    ),
    {
      cleanContent: "hi @Hacker News",
      markers: [
        {
          kind: "skill",
          label: "Feynman",
          type: "command",
          value: "/feynman",
        },
        {
          sourceId: "source-1",
          title: "Hacker News",
          type: "source",
        },
        {
          kind: "tool",
          label: "Generate image",
          type: "command",
          value: "/generate_image",
        },
      ],
    },
  );
});

test("parsePromptMarkers preserves escaped marker labels", () => {
  assert.deepEqual(
    testExports.parsePromptMarkers(
      String.raw`[source:source-1](Quarterly (Q1\) \] Report) [skill-command:feynman%3Asimplify](Feynman Simplify) hi`,
    ),
    {
      cleanContent: "@Quarterly (Q1) ] Report hi",
      markers: [
        {
          sourceId: "source-1",
          title: "Quarterly (Q1) ] Report",
          type: "source",
        },
        {
          kind: "skill-command",
          label: "Feynman Simplify",
          type: "command",
          value: "/feynman:simplify",
        },
      ],
    },
  );
});

test("resolveThreadCommand resolves slash skill activation when skill was loaded by slug", () => {
  const command = testExports.resolveThreadCommand({
    command: testExports.parseRequestedCommand({
      command: {
        arguments: "解释二八定律",
        kind: "skill",
        name: "/feynman",
      },
    }),
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "builtin",
        name: "feynman",
        displayName: "Feynman",
        version: "1.0.0",
        description: "Use the Feynman technique",
        slash: true,
        files: [],
      },
    ],
  });

  assert.deepEqual(command, {
    arguments: "解释二八定律",
    canonicalName: "/feynman",
    description: "Use the Feynman technique",
    displayName: "Feynman",
    kind: "skill",
    name: "/feynman",
    skillSlug: "feynman",
  });
});

test("resolveThreadCommand resolves slash skill command when skill was loaded by slug", () => {
  const command = testExports.resolveThreadCommand({
    command: testExports.parseRequestedCommand({
      command: {
        arguments: "解释二八定律",
        kind: "skill-command",
        name: "/feynman:explain",
      },
    }),
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "builtin",
        name: "feynman",
        displayName: "Feynman",
        version: "1.0.0",
        description: "Use the Feynman technique",
        slash: true,
        commands: [
          {
            id: "feynman:explain",
            name: "explain",
            canonicalName: "/feynman:explain",
            displayName: "Explain",
            description: "Explain simply",
            path: "commands/explain.md",
            instruction: "Explain $ARGUMENTS simply",
            skillSlugs: ["feynman"],
          },
        ],
        files: [],
      },
    ],
  });

  assert.equal(command?.kind, "skill-command");
  assert.equal(command?.canonicalName, "/feynman:explain");
  assert.equal(command?.arguments, "解释二八定律");
  assert.equal(command?.instruction, "Explain $ARGUMENTS simply");
});

test("resolveThreadCommand resolves Notion tool slash command", () => {
  const command = testExports.resolveThreadCommand({
    command: testExports.parseRequestedCommand({
      command: {
        arguments: "TEST",
        kind: "tool",
        name: "/search_notion_pages",
      },
    }),
    enabledSkills: [],
  });

  assert.deepEqual(command, {
    arguments: "TEST",
    canonicalName: "/search_notion_pages",
    description: "Search indexed Notion pages",
    displayName: "Search Notion pages",
    kind: "tool",
    name: "/search_notion_pages",
    skillSlug: "",
    toolName: "search_notion_pages",
  });
});

test("buildCommandAugmentedText instructs explicit tool command usage", () => {
  assert.equal(
    testExports.buildCommandAugmentedText({
      command: {
        arguments: "TEST",
        canonicalName: "/search_notion_pages",
        description: "Search indexed Notion pages",
        displayName: "Search Notion pages",
        kind: "tool",
        name: "/search_notion_pages",
        skillSlug: "",
        toolName: "search_notion_pages",
      },
      text: "TEST",
    }),
    `<sourceweft_tool_command name="search_notion_pages">
Use the search_notion_pages tool for this request. Treat the user request below as the tool input; do not answer without using the selected tool unless the input is invalid or the tool is unavailable.
</sourceweft_tool_command>

<user_request>
TEST
</user_request>`,
  );
});

test("buildCommandAugmentedText leaves skill activation text unchanged", () => {
  assert.equal(
    testExports.buildCommandAugmentedText({
      command: {
        arguments: "Show active users",
        canonicalName: "/pm-data-analytics",
        description: "Analytics skill",
        displayName: "PM Data Analytics",
        kind: "skill",
        name: "/pm-data-analytics",
        skillSlug: "pm-data-analytics",
      },
      text: "Show active users",
    }),
    "Show active users",
  );
});

test("buildCommandAugmentedText injects skill command instructions", () => {
  assert.match(
    testExports.buildCommandAugmentedText({
      command: {
        arguments: "Show active users",
        canonicalName: "/pm-data-analytics:write-query",
        commandName: "write-query",
        description: "Write query",
        displayName: "Write query",
        instruction: "Use $ARGUMENTS to write SQL",
        kind: "skill-command",
        name: "/pm-data-analytics:write-query",
        path: "commands/write-query.md",
        skillSlug: "pm-data-analytics",
      },
      text: "Show active users",
    }),
    /<sourceweft_command name="\/pm-data-analytics:write-query" path="\/skills\/pm-data-analytics\/commands\/write-query.md">/,
  );
});

test("buildThreadCommandMetadata preserves display labels and routing fields", () => {
  assert.deepEqual(
    testExports.buildThreadCommandMetadata({
      arguments: "Show active users",
      canonicalName: "/pm-data-analytics:write-query",
      commandName: "write-query",
      description: "Write query",
      displayName: "Write Query",
      instruction: "Use $ARGUMENTS to write SQL",
      kind: "skill-command",
      name: "/pm-data-analytics:write-query",
      path: "commands/write-query.md",
      skillSlug: "pm-data-analytics",
    }),
    {
      arguments: "Show active users",
      commandName: "write-query",
      displayName: "Write Query",
      kind: "skill-command",
      name: "/pm-data-analytics:write-query",
      path: "commands/write-query.md",
      skillSlug: "pm-data-analytics",
    },
  );
});
