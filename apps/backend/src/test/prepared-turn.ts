import type { PreparedThreadTurn } from "../modules/threads";

/**
 * Overrides are keyed like PreparedThreadTurn but their values are not
 * type-checked: the hand-written builders this replaces all cast partial
 * nested objects (`thread: { id }`) and the code under test only reads the
 * fields a given test sets.
 */
export type PreparedThreadTurnOverrides = {
  [K in keyof PreparedThreadTurn]?: unknown;
};

/**
 * A complete PreparedThreadTurn with neutral fixture values. Tests override
 * only the fields they exercise; a plain "test" user message on a private
 * thread with no sources, skills, tools or command is the default.
 */
export function createPreparedThreadTurn(
  overrides: PreparedThreadTurnOverrides = {},
): PreparedThreadTurn {
  return {
    userId: "user_test",
    workspace: { id: "workspace_test", organizationId: "team_test" },
    thread: { id: "thread_test" },
    messageContent: "test",
    messageContentJson: { type: "text", text: "test" },
    imageParts: [],
    preflightBilling: [],
    preflightThinkingSteps: [],
    agentMessageContent: "test",
    mentionedSourceIds: [],
    effectiveMentionedSourceIds: [],
    selectedSourceIds: [],
    sourceIds: [],
    sourceScope: {
      requestedSourceIds: [],
      effectiveSourceIds: [],
      selectedDirectoryIds: [],
      expandedDescendantSourceIds: [],
    },
    skillIds: [],
    invokedSkillIds: [],
    selectedSkillIds: [],
    webAccessEnabled: false,
    notionTools: {},
    mcpTools: {},
    command: null,
    invocation: null,
    commandSuccessCriteria: { kind: "none" },
    toolPermissions: {},
    effectiveTools: {},
    runtimeTools: {},
    turnState: {},
    timezone: "UTC",
    enabledSkills: [],
    userMessage: { id: "message_test", metadata: {} },
    runTraceId: "run_test",
    createdUserMessage: true,
    assistantMessageParentId: null,
    assistantMessageId: null,
    profileAlias: "test-profile",
    modelAlias: "test-model",
    providerModel: "test-provider-model",
    chatProfile: { gatewayConfigId: "gateway_test", configJson: {} },
    llm: undefined,
    llmIdempotencyKey: "llm_test",
    agentMode: "continue",
    agentBaseCheckpoint: null,
    agentRunThreadId: "agent_run_test",
    toolApprovalResume: null,
    traceContinuation: null,
    isFirstAssistantResponse: true,
    isFirstAssistantAttempt: true,
    initialTitle: "Test",
    failurePersistence: "persist-error-turn",
    mcpInstallIds: [],
    persona: null,
    ...overrides,
  } as unknown as PreparedThreadTurn;
}
