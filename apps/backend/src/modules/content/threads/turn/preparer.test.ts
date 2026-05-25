import assert from "node:assert/strict";
import { test } from "vitest";
import type { MeterConsumeRequest } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../billing-port";
import type { MessageRecord } from "../../types";
import { filterMessagesBeforeEditAnchor } from "./context";
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

function message(
  overrides: Partial<MessageRecord> & Pick<MessageRecord, "id" | "role">,
): MessageRecord {
  return {
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: null,
    content: "",
    createdBy: overrides.role === "user" ? "user-1" : null,
    model: null,
    creditsConsumed: null,
    contentJson: {},
    metadata: {},
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
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

test("tool confirmation resume prefers the HITL resume checkpoint", () => {
  const checkpoint = inputTestExports.resolveToolConfirmationResumeCheckpoint({
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
  });

  assert.deepEqual(checkpoint, {
    threadId: "thread-1",
    checkpointId: "resume",
  });
});

test("tool confirmation resume requires an interrupt checkpoint", () => {
  assert.throws(
    () =>
      inputTestExports.resolveToolConfirmationResumeCheckpoint(null),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "THREAD_CONFIRMATION_CHECKPOINT_MISSING",
  );
});

test("tool confirmation resume carries prior approved connector actions", () => {
  const priorActions =
    inputTestExports.extractApprovedConnectorActionsFromMessage({
      metadata: {
        toolCalls: [
          {
            id: "tool-call-1",
            tool: "append_notion_page",
            output: {
              type: "tool_confirmation_request",
              id: "old-confirmation",
              status: "approved",
              action: {
                toolName: "append_notion_page",
              },
              preview: {
                requestJson: {
                  content: "Old summary",
                  pageId: "test-page",
                },
              },
              execution: {
                executor: {
                  kind: "connector_action_run",
                  connectorId: "connector-1",
                  actionRunId: "old-action",
                },
              },
            },
          },
          {
            id: "tool-call-2",
            tool: "append_notion_page",
            output: {
              type: "tool_confirmation_request",
              id: "pending-confirmation",
              status: "proposed",
              action: {
                toolName: "append_notion_page",
              },
              preview: {
                requestJson: {
                  content: "New summary",
                  pageId: "test-page",
                },
              },
              execution: {
                executor: {
                  kind: "connector_action_run",
                  connectorId: "connector-1",
                  actionRunId: "pending-action",
                },
              },
            },
          },
        ],
      },
    });

  assert.deepEqual(priorActions, [
    {
      actionRunId: "old-action",
      connectorId: "connector-1",
      requestJson: {
        content: "Old summary",
        pageId: "test-page",
      },
      toolName: "append_notion_page",
    },
  ]);

  const resume = inputTestExports.mergeToolApprovalResumeConnectorActions({
    priorConnectorActions: priorActions,
    resume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        connectorActions: [
          {
            actionRunId: "new-action",
            connectorId: "connector-1",
            requestJson: {
              content: "New summary",
              pageId: "test-page",
            },
            toolName: "append_notion_page",
          },
        ],
      },
    },
  });

  assert.deepEqual(resume.decisions, [{ type: "approve" }]);
  assert.deepEqual(resume.sourceweft?.connectorActions, [
    {
      actionRunId: "old-action",
      connectorId: "connector-1",
      requestJson: {
        content: "Old summary",
        pageId: "test-page",
      },
      toolName: "append_notion_page",
    },
    {
      actionRunId: "new-action",
      connectorId: "connector-1",
      requestJson: {
        content: "New summary",
        pageId: "test-page",
      },
      toolName: "append_notion_page",
    },
  ]);
});

test("trace continuation derives max sequence and tool sequence map", () => {
  assert.deepEqual(
    testExports.resolveTraceContinuationMetadata({
      metadata: {
        reasoningSegments: [
          {
            id: "initial-reasoning",
            text: "Need to search first.",
            sequence: 1,
          },
          {
            id: "after-search",
            text: "Found the page.",
            sequence: 3,
          },
        ],
        toolCalls: [
          {
            id: "search-page",
            tool: "search_notion_pages",
            sequence: 2,
          },
          {
            id: "create-page",
            tool: "create_notion_page",
            sequence: 4,
          },
        ],
        thinkingSteps: [
          {
            id: "verify",
            title: "Checking citations",
            status: "completed",
            items: [],
            sequence: 5,
          },
        ],
      },
    } as never),
    {
      maxSequence: 5,
      toolSequenceById: {
        "create-page": 4,
        "search-page": 2,
      },
      traceParts: [],
    },
  );

  assert.equal(testExports.resolveTraceContinuationMetadata(null), null);
});

test("edit base checkpoint ignores the edited turn assistant result", () => {
  const messages = [
    message({
      id: "setup-user",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    message({
      id: "setup-assistant",
      role: "assistant",
      createdAt: "2026-01-01T00:01:00.000Z",
      metadata: {
        agentCheckpoint: {
          final: {
            threadId: "agent-thread",
            checkpointId: "setup-final",
          },
        },
      },
    }),
    message({
      id: "delete-user",
      role: "user",
      createdAt: "2026-01-01T00:02:00.000Z",
    }),
    message({
      id: "delete-failed-assistant",
      role: "assistant",
      createdAt: "2026-01-01T00:03:00.000Z",
      metadata: {
        userMessageId: "delete-user",
        agentCheckpoint: {
          beforeInput: {
            threadId: "agent-thread",
            checkpointId: "delete-before-input",
          },
          final: {
            threadId: "agent-thread",
            checkpointId: "delete-failed-final",
          },
        },
      },
    }),
  ];

  assert.deepEqual(
    inputTestExports.resolveEditBaseCheckpointFromMessages({
      latestUserMessageId: "delete-user",
      messages,
    }),
    {
      threadId: "agent-thread",
      checkpointId: "setup-final",
    },
  );
});

test("edit context fallback ignores later source and checkpoint state", () => {
  const messages = [
    message({
      id: "setup-user",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { sourceIds: ["setup-source"] },
    }),
    message({
      id: "setup-assistant",
      role: "assistant",
      createdAt: "2026-01-01T00:01:00.000Z",
      metadata: {
        agentCheckpoint: {
          final: {
            threadId: "agent-thread",
            checkpointId: "setup-final",
          },
        },
      },
    }),
    message({
      id: "edited-user",
      role: "user",
      createdAt: "2026-01-01T00:02:00.000Z",
      metadata: { sourceIds: ["edited-source"] },
    }),
    message({
      id: "old-assistant",
      role: "assistant",
      createdAt: "2026-01-01T00:03:00.000Z",
      metadata: {
        agentCheckpoint: {
          final: {
            threadId: "agent-thread",
            checkpointId: "old-final",
          },
        },
      },
    }),
    message({
      id: "later-user",
      role: "user",
      createdAt: "2026-01-01T00:04:00.000Z",
      metadata: { sourceIds: ["later-source"] },
    }),
  ];
  const editContextMessages = filterMessagesBeforeEditAnchor({
    anchorUserMessageId: "edited-user",
    messages,
  });

  assert.deepEqual(testExports.resolveLatestSourceIds(editContextMessages), [
    "setup-source",
  ]);
  assert.deepEqual(
    testExports.resolveLatestAssistantFinalCheckpoint(editContextMessages),
    {
      threadId: "agent-thread",
      checkpointId: "setup-final",
    },
  );
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
        tools: ["search_notion_pages"],
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
    workflow: {
      arguments: "解释二八定律",
      defaultTools: ["search_notion_pages"],
      execution: "agent",
      kind: "workflow",
      name: "/feynman",
      permissionOverrides: {},
      renderedPrompt:
        '<sourceweft_command name="/feynman" kind="workflow" skill="feynman">\nRun the selected skill workflow for the user\'s request.\nThis slash command is a task request, not a passive tool toggle. Apply the loaded skill instructions and use relevant enabled tools when helpful.\n</sourceweft_command>\n\n<user_request>\n解释二八定律\n</user_request>',
      successCriteria: { kind: "none" },
    },
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
  assert.equal(command?.workflow?.kind, "workflow");
  assert.equal(command?.workflow?.execution, "agent");
  assert.deepEqual(command?.workflow?.successCriteria, { kind: "none" });
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /<sourceweft_command name="\/feynman:explain" kind="workflow" skill="feynman" path="\/skills\/feynman\/commands\/explain.md">/,
  );
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
    description: "Find Notion pages and return page IDs",
    displayName: "Find Notion pages",
    kind: "tool",
    name: "/search_notion_pages",
    skillSlug: "",
    toolName: "search_notion_pages",
    workflow: {
      arguments: "TEST",
      defaultTools: ["search_notion_pages"],
      execution: "agent",
      kind: "tool_workflow",
      name: "/search_notion_pages",
      permissionOverrides: {
        search_notion_pages: "allow",
      },
      renderedPrompt:
        '<sourceweft_command name="/search_notion_pages" kind="tool_workflow" tool="search_notion_pages">\nFind Notion pages for the user\'s request and return the relevant page IDs, titles, and URLs. Search is for discovery only; use page IDs for reading, updating, or deleting.\nThis slash command is a task request, not a passive tool toggle. Use any relevant enabled support tools first if needed, but the command\'s success criteria must be satisfied.\nSuccess criteria: call search_notion_pages.\n</sourceweft_command>\n\n<user_request>\nTEST\n</user_request>',
      successCriteria: {
        kind: "tool_call",
        toolName: "search_notion_pages",
      },
    },
  });
});

test("buildCommandAugmentedText uses normalized tool workflow prompt", () => {
  const command = testExports.resolveThreadCommand({
    command: testExports.parseRequestedCommand({
      command: {
        arguments: "roadmap",
        kind: "tool",
        name: "/search_notion_pages",
      },
    }),
    enabledSkills: [],
  });

  const text = testExports.buildCommandAugmentedText({
    command,
    text: "ignored",
  });

  assert.match(text, /kind="tool_workflow"/);
  assert.match(text, /Success criteria: call search_notion_pages/);
});

test("create Notion tool workflow defaults to authorized workspace", () => {
  const command = testExports.resolveThreadCommand({
    command: testExports.parseRequestedCommand({
      command: {
        arguments: "保存会议纪要",
        kind: "tool",
        name: "/create_notion_page",
      },
    }),
    enabledSkills: [],
  });

  assert.equal(command?.description, "Create a Notion page in the authorized workspace unless an explicit parent page or data source ID is provided");
  assert.match(command?.workflow?.renderedPrompt ?? "", /authorized Notion workspace selected by the active connector/);
  assert.match(command?.workflow?.renderedPrompt ?? "", /do not pass parentPageId, pageId, or dataSourceId/);
  assert.match(command?.workflow?.renderedPrompt ?? "", /Only pass parentPageId\/pageId or dataSourceId when the user explicitly requested/);
});

test("resolveToolPermissions keeps explicit deny above command overrides", () => {
  const command = testExports.resolveThreadCommand({
    command: testExports.parseRequestedCommand({
      command: {
        arguments: "roadmap",
        kind: "tool",
        name: "/search_notion_pages",
      },
    }),
    enabledSkills: [],
  });

  const permissions = testExports.resolveToolPermissions({
    command,
    tools: {
      search_notion_pages: { enabled: false },
    },
  });
  assert.equal(permissions.search_notion_pages, "deny");
  assert.equal(permissions.search_sources, "allow");
  assert.equal(permissions.web_search, undefined);
});

test("resolveToolPermissions includes skill-activated tools as capabilities", () => {
  assert.equal(
    testExports.resolveToolPermissions({
      command: null,
      enabledSkills: [
        {
          workspaceSkillId: "skill-1",
          sourceType: "workspace_custom",
          name: "notion-skill",
          version: "1.0.0",
          description: "Use Notion",
          tools: ["search_notion_pages"],
          files: [],
        },
      ],
      tools: undefined,
    }).search_notion_pages,
    "allow",
  );
});

test("buildCommandAugmentedText instructs explicit tool command usage", () => {
  assert.match(
    testExports.buildCommandAugmentedText({
      command: {
        arguments: "TEST",
        canonicalName: "/search_notion_pages",
        description: "Find Notion pages and return page IDs",
        displayName: "Find Notion pages",
        kind: "tool",
        name: "/search_notion_pages",
        skillSlug: "",
        toolName: "search_notion_pages",
        workflow: {
          arguments: "TEST",
          defaultTools: ["search_notion_pages"],
          execution: "agent",
          kind: "tool_workflow",
          name: "/search_notion_pages",
          permissionOverrides: {
            search_notion_pages: "allow",
          },
          renderedPrompt:
            '<sourceweft_command name="/search_notion_pages" kind="tool_workflow" tool="search_notion_pages">\nFind Notion pages for the user\'s request and return the relevant page IDs, titles, and URLs. Search is for discovery only; use page IDs for reading, updating, or deleting.\nThis slash command is a task request, not a passive tool toggle. Use any relevant enabled support tools first if needed, but the command\'s success criteria must be satisfied.\nSuccess criteria: call search_notion_pages.\n</sourceweft_command>\n\n<user_request>\nTEST\n</user_request>',
          successCriteria: {
            kind: "tool_call",
            toolName: "search_notion_pages",
          },
        },
      },
      text: "TEST",
    }),
    /kind="tool_workflow" tool="search_notion_pages"/,
  );
});

test("buildCommandAugmentedText uses normalized skill activation workflow prompt", () => {
  assert.match(
    testExports.buildCommandAugmentedText({
      command: {
        arguments: "Show active users",
        canonicalName: "/pm-data-analytics",
        description: "Analytics skill",
        displayName: "PM Data Analytics",
        kind: "skill",
        name: "/pm-data-analytics",
        skillSlug: "pm-data-analytics",
        workflow: {
          arguments: "Show active users",
          defaultTools: [],
          execution: "agent",
          kind: "workflow",
          name: "/pm-data-analytics",
          permissionOverrides: {},
          renderedPrompt:
            '<sourceweft_command name="/pm-data-analytics" kind="workflow" skill="pm-data-analytics">\nRun the selected skill workflow for the user\'s request.\nThis slash command is a task request, not a passive tool toggle. Apply the loaded skill instructions and use relevant enabled tools when helpful.\n</sourceweft_command>\n\n<user_request>\nShow active users\n</user_request>',
          successCriteria: { kind: "none" },
        },
      },
      text: "Show active users",
    }),
    /kind="workflow" skill="pm-data-analytics"/,
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
        workflow: {
          arguments: "Show active users",
          defaultTools: [],
          execution: "agent",
          kind: "workflow",
          name: "/pm-data-analytics:write-query",
          permissionOverrides: {},
          renderedPrompt:
            '<sourceweft_command name="/pm-data-analytics:write-query" kind="workflow" skill="pm-data-analytics" path="/skills/pm-data-analytics/commands/write-query.md">\nUse Show active users to write SQL\n</sourceweft_command>\n\n<user_request>\nShow active users\n</user_request>',
          successCriteria: { kind: "none" },
        },
      },
      text: "Show active users",
    }),
    /<sourceweft_command name="\/pm-data-analytics:write-query" kind="workflow" skill="pm-data-analytics" path="\/skills\/pm-data-analytics\/commands\/write-query.md">/,
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
