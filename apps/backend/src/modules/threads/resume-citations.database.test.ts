import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { createPreparedThreadTurn } from "../../test/prepared-turn";
import { createBillingPort } from "../../test/thread-stream-fixtures";
import type { AgentCitation, DeepAgentTurnEvent } from "./agent";
import type { MessageRecord } from "../content/types";
import type { PreparedThreadTurn, ToolCallTrace } from "./turn/types";
import type { ChatRunSnapshot, ChatThreadRunRecord } from "./durable/types";

/**
 * Issue #358: an approval resume keeps the paused run's citation registry.
 *
 * Both runs go through the real durable runner (`processThreadChatRunJob`),
 * the real stream service, the real finalizer and PostgreSQL. Only the agent
 * graph is scripted; each turn uses the real turn runtime, and the resume
 * reads its continuation from the stored paused message with the preparer's
 * own reader, then opens and closes like `invokeDeepAgentTurn`.
 */

const mocked = vi.hoisted(() => ({
  stream: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("./stream/service", () => ({
  ContentThreadStreamService: class {
    streamThreadEvents(...args: unknown[]) {
      return mocked.stream(...args);
    }
    resumeThreadEvents(...args: unknown[]) {
      return mocked.resume(...args);
    }
  },
}));

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./durable/repository");
let runner: typeof import("./durable/runner");
let streams: typeof import("./durable/stream-manager");
let messages: typeof import("./message-repository");
let clientView: typeof import("./message-client-view");
let preparer: typeof import("./turn/preparer");
let turnRuntime: typeof import("./agent/turn/turn-runtime");
let citationTracker: typeof import("./agent/turn/citation-tracker");
let finalOutcome: typeof import("./agent/turn/final-outcome");
let reasoningState: typeof import("./turn/reasoning-state");
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let threadId: string;
const userId = "resume-citations-user";

const PAUSED_TEXT = "Revenue grew [citation:c2], led by exports [citation:c3].";
const RESUMED_TEXT =
  "The skill confirms the export share [citation:c3] and the margin [citation:c4].";

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("resume_cite");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./durable/repository");
  runner = await import("./durable/runner");
  streams = await import("./durable/stream-manager");
  messages = await import("./message-repository");
  clientView = await import("./message-client-view");
  preparer = await import("./turn/preparer");
  turnRuntime = await import("./agent/turn/turn-runtime");
  citationTracker = await import("./agent/turn/citation-tracker");
  finalOutcome = await import("./agent/turn/final-outcome");
  reasoningState = await import("./turn/reasoning-state");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Resume citations",
    slug: `resume-citations-${workspaceId}`,
  });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Export report",
  });
  vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
    async () => {},
  );
  let appended = 0;
  vi.spyOn(streams.chatRunStreamManager, "appendEvent").mockImplementation(
    async () => ++appended,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  mocked.stream.mockReset();
  mocked.resume.mockReset();
  if (schema)
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function addEvidence(
  runtime: ReturnType<typeof turnRuntime.createTurnRuntime>,
  index: number,
) {
  // External evidence: its citation records need no source rows.
  return runtime.citationRegistry.addExternal({
    origin: "web_fetch",
    externalUri: `https://example.com/report-${index}`,
    sourceTitle: `Report ${index}`,
    content: `Evidence ${index}: exports and margins for the quarter.`,
  });
}

/** The pending `enable_skill` call, with the HITL handler's confirmation. */
const ENABLE_SKILL_CALL: ToolCallTrace = {
  id: "call-enable-skill",
  tool: "enable_skill",
  input: { skillId: "export-analysis" },
  status: "running",
  latencyMs: null,
  error: null,
  sequence: 1,
  output: {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "call-enable-skill",
    domain: "skills",
    subject: { label: "Workspace skills" },
    action: {
      type: "enable_skill",
      toolName: "enable_skill",
      label: "Enable skill",
      riskLevel: "low",
      status: "proposed",
      requiresApproval: true,
    },
    preview: { title: "Switch a skill back on" },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "agent_tool_call" },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  },
};

/**
 * The paused turn's outcome, as hitl-stream-handler builds it: no used
 * citations, the registry as the available ones, and no closing citations
 * event.
 */
function pausedOutcome(
  runtime: ReturnType<typeof turnRuntime.createTurnRuntime>,
): DeepAgentTurnEvent {
  return {
    type: "done",
    outcome: {
      assistantContent: PAUSED_TEXT,
      finishReason: "tool_confirmation_requested",
      retrieval: null,
      citations: [],
      availableCitations: runtime.citationRegistry.list(),
      retrievalCalls: [],
      toolCalls: [ENABLE_SKILL_CALL],
      meteredLlmCalls: [],
      thinkingSteps: [],
      reasoningSegments: [],
      agentCheckpoint: {
        beforeInput: null,
        beforeAssistant: null,
        resume: null,
        final: null,
      },
    },
  };
}

/** The paused send turn: three citations, two of them cited, then approval. */
async function* pausedTurn(
  prepared: PreparedThreadTurn,
): AsyncGenerator<DeepAgentTurnEvent> {
  const runtime = turnRuntime.createTurnRuntime({ prepared });
  for (const index of [1, 2, 3]) addEvidence(runtime, index);
  const snapshot = runtime.getNewCitationSnapshot();
  assert.ok(snapshot);
  yield { type: "citations", citations: snapshot };
  yield { type: "text-delta", delta: PAUSED_TEXT };
  yield {
    type: "tool-call-start",
    id: ENABLE_SKILL_CALL.id,
    tool: ENABLE_SKILL_CALL.tool,
    input: ENABLE_SKILL_CALL.input,
    toolCall: ENABLE_SKILL_CALL,
  };
  yield pausedOutcome(runtime);
}

/**
 * The approval resume: opens like `invokeDeepAgentTurn` (the continued
 * registry first), finds one new chunk, and closes through the real final
 * outcome.
 */
async function* resumedTurn(
  prepared: PreparedThreadTurn,
  opened: DeepAgentTurnEvent[],
): AsyncGenerator<DeepAgentTurnEvent> {
  const runtime = turnRuntime.createTurnRuntime({ prepared });
  const continued = citationTracker.continuedCitationsEvent({
    prepared,
    getNewCitationSnapshot: runtime.getNewCitationSnapshot,
  });
  if (continued) {
    opened.push(continued);
    yield continued;
  }
  addEvidence(runtime, 4);
  const snapshot = runtime.getNewCitationSnapshot();
  assert.ok(snapshot);
  yield { type: "citations", citations: snapshot };
  runtime.assistantContent = RESUMED_TEXT;
  runtime.renderBlocks.appendText(RESUMED_TEXT);
  runtime.hasStreamedText = true;
  yield { type: "text-delta", delta: RESUMED_TEXT };
  yield* finalOutcome.buildFinalOutcome({
    agent: { getState: vi.fn().mockResolvedValue(null) } as never,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    finalCheckpoint: null,
    prepared,
    runConfig: {} as never,
    runtime,
  });
}

function preparedTurn(input: {
  run: ChatThreadRunRecord;
  userMessage: MessageRecord;
  overrides?: Parameters<typeof createPreparedThreadTurn>[0];
}): PreparedThreadTurn {
  return createPreparedThreadTurn({
    userId,
    workspace: { id: workspaceId, organizationId: teamId },
    thread: {
      id: threadId,
      teamId,
      workspaceId,
      title: "Export report",
      modelSettings: {
        llmProfileAlias: null,
        imageProfileAlias: null,
        visionProfileAlias: null,
        llmModelAlias: null,
        imageModelAlias: null,
        visionModelAlias: null,
      },
      chatPreferences: {
        thinking: { mode: "off" },
        webAccess: false,
        composerOptions: {},
      },
      sourceCount: 0,
      visibility: "private",
      parentThreadId: null,
      personaId: null,
      origin: "user",
      createdBy: userId,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastMessageAt: null,
    },
    messageContent: input.userMessage.content,
    messageContentJson: {
      version: 1,
      parts: [{ type: "text", text: input.userMessage.content }],
    },
    agentMessageContent: input.userMessage.content,
    userMessage: input.userMessage,
    runTraceId: input.run.id,
    reasoningRun: { runId: input.run.id, parentRunId: null, base: "" },
    assistantMessageIdOverride: null,
    modelAlias: "deepseek-v4-flash",
    profileAlias: "default-chat",
    providerModel: "deepseek/deepseek-v4-flash",
    chatProfile: { gatewayConfigId: "gateway-resume", configJson: {} },
    llmIdempotencyKey: `thread-stream:${input.userMessage.id}:assistant`,
    agentRunThreadId: threadId,
    initialTitle: "Export report",
    isFirstAssistantResponse: false,
    ...input.overrides,
  });
}

async function streamServiceFor(input: {
  prepare: () => Promise<PreparedThreadTurn>;
  turn: (prepared: PreparedThreadTurn) => AsyncGenerator<DeepAgentTurnEvent>;
}) {
  const { ContentThreadStreamService } =
    await vi.importActual<typeof import("./stream/service")>(
      "./stream/service",
    );
  const { ContentThreadTurnService } = await import("./turn/service");
  const billing = createBillingPort();
  const turnService = new ContentThreadTurnService(billing);
  return new ContentThreadStreamService(
    {
      prepareThreadTurn: input.prepare,
      // The real finalizer: message projection, citation records.
      finalizeThreadTurn: (
        command: Parameters<typeof turnService.finalizeThreadTurn>[0],
      ) => turnService.finalizeThreadTurn(command),
    } as unknown as ConstructorParameters<typeof ContentThreadStreamService>[0],
    ((args: { prepared: PreparedThreadTurn }) =>
      input.turn(args.prepared)) as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[1],
    async () => null,
    undefined,
    billing,
  );
}

async function readRun(runId: string) {
  const run = await repository.findChatThreadRunById({
    runId,
    teamId,
    workspaceId,
  });
  assert.ok(run);
  return run;
}

async function readAssistant(messageId: string) {
  // The /messages path: the page query with full include, then the client view.
  const page = await messages.listMessageRecordPageByThread({
    include: { citations: true, contentJson: true, metadata: true },
    teamId,
    workspaceId,
    threadId,
    limit: 50,
  });
  const stored = page.items.find((item) => item.id === messageId);
  assert.ok(stored, "assistant message missing from the /messages page");
  return { stored, view: clientView.projectThreadMessageForClient(stored) };
}

function citationKeys(value: unknown) {
  assert.ok(Array.isArray(value), "expected a citation list");
  return (value as AgentCitation[]).map((citation) => citation.citation);
}

function retrievalOf(metadata: Record<string, unknown>) {
  return metadata.retrieval as {
    citations: AgentCitation[];
    availableCitations: AgentCitation[];
  };
}

test("an approval resume keeps the paused registry and merges new evidence", async () => {
  // 1. The send run cites c2/c3 and pauses for approval.
  const sendRun = await repository.createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId,
    idempotencyKey: `resume-citations:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId,
      content: "Summarize the export report.",
    },
  });
  assert.ok(sendRun);
  let userMessage: MessageRecord | undefined;
  const sendService = await streamServiceFor({
    prepare: async () => {
      userMessage = await messages.createMessageRecord({
        teamId,
        workspaceId,
        threadId,
        role: "user",
        content: "Summarize the export report.",
        createdBy: null,
      });
      return preparedTurn({ run: sendRun, userMessage });
    },
    turn: pausedTurn,
  });
  mocked.stream.mockImplementation(
    (...args: Parameters<typeof sendService.streamThreadEvents>) =>
      sendService.streamThreadEvents(...args),
  );
  const paused = await runner.processThreadChatRunJob({
    runId: sendRun.id,
    teamId,
    workspaceId,
    threadId,
    userId,
  });
  assert.equal(paused.status, "waiting_for_approval", JSON.stringify(paused));
  const assistantMessageId = paused.assistantMessageId;
  assert.ok(assistantMessageId && userMessage);

  const beforeResume = await readAssistant(assistantMessageId);
  assert.deepEqual(
    citationKeys(retrievalOf(beforeResume.view.metadata).availableCitations),
    ["c1", "c2", "c3"],
  );

  // 2. Approve: the waiting run records the decision, then the resume run
  // continues the same message.
  const approved = await repository.recordChatThreadRunConfirmationResponse({
    runId: sendRun.id,
    teamId,
    workspaceId,
    confirmationId: ENABLE_SKILL_CALL.id,
    confirmation: {
      ...(ENABLE_SKILL_CALL.output as Record<string, unknown>),
      status: "approved",
    },
  });
  assert.equal(approved?.status, "completed");
  const approvedRow = await readAssistant(assistantMessageId);
  assert.deepEqual(
    citationKeys(retrievalOf(approvedRow.view.metadata).availableCitations),
    ["c1", "c2", "c3"],
  );
  const resumeRun = await repository.createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId,
    idempotencyKey: `resume-citations:${randomUUID()}`,
    mode: "resume",
    requestJson: {
      mode: "resume",
      workspaceId,
      threadId,
      userId,
      assistantMessageId,
      toolApprovalResume: { decisions: [{ type: "approve" }] },
    } as never,
  });
  assert.ok(resumeRun);
  const opened: DeepAgentTurnEvent[] = [];
  const resumeService = await streamServiceFor({
    prepare: async () => {
      const pausedMessage = await messages.findMessageRecord({
        teamId,
        workspaceId,
        messageId: assistantMessageId,
      });
      assert.ok(pausedMessage);
      return preparedTurn({
        run: resumeRun,
        userMessage: userMessage!,
        overrides: {
          assistantMessageId,
          assistantMessageParentId: pausedMessage.parentMessageId,
          agentMode: "replay",
          toolApprovalResume: { decisions: [{ type: "approve" }] },
          reasoningRun: reasoningState.beginReasoningRun({
            runId: resumeRun.id,
            continuation: true,
            metadata: pausedMessage.metadata,
          }),
          // The preparer's reader, on the stored paused message.
          traceContinuation:
            preparer.testExports.resolveTraceContinuationMetadata(
              pausedMessage,
            ),
        },
      });
    },
    turn: (prepared) => resumedTurn(prepared, opened),
  });
  mocked.resume.mockImplementation(
    (
      request: Parameters<typeof resumeService.streamThreadEvents>[0],
      options: Parameters<typeof resumeService.streamThreadEvents>[1],
    ) => resumeService.streamThreadEvents(request, options),
  );
  const resumed = await runner.processThreadChatRunJob({
    runId: resumeRun.id,
    teamId,
    workspaceId,
    threadId,
    userId,
  });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed));
  assert.equal(resumed.assistantMessageId, assistantMessageId);

  // 3. The resume run's snapshot keeps the registry, with c4 merged after it.
  const snapshot = (await readRun(resumeRun.id))
    .snapshotJson as ChatRunSnapshot;
  assert.deepEqual(citationKeys(snapshot.retrieval?.availableCitations), [
    "c1",
    "c2",
    "c3",
    "c4",
  ]);
  assert.deepEqual(citationKeys(snapshot.retrieval?.citations), [
    "c2",
    "c3",
    "c4",
  ]);

  // 4. The messages row and the /messages view resolve every cited id.
  const { stored, view } = await readAssistant(assistantMessageId);
  assert.ok(stored.content.includes(PAUSED_TEXT), stored.content);
  assert.ok(stored.content.includes(RESUMED_TEXT), stored.content);
  for (const metadata of [stored.metadata, view.metadata]) {
    const retrieval = retrievalOf(metadata);
    assert.deepEqual(citationKeys(retrieval.availableCitations), [
      "c1",
      "c2",
      "c3",
      "c4",
    ]);
    assert.deepEqual(citationKeys(retrieval.citations), ["c2", "c3", "c4"]);
  }
  const resolvable = new Set(
    citationKeys(retrievalOf(view.metadata).availableCitations),
  );
  for (const [, key] of stored.content.matchAll(/\[citation:(c\d+)\]/g)) {
    assert.ok(resolvable.has(key!), `[citation:${key}] does not resolve`);
  }
  // The pre-pause evidence keeps its identity: c2 is still report 2.
  const c2 = retrievalOf(view.metadata).availableCitations.find(
    (citation) => citation.citation === "c2",
  );
  assert.equal(c2?.externalUri, "https://example.com/report-2");
  // The citation records the finalizer replaces for the continued message.
  const records = await schema.db
    .select({ citationKey: schema.citations.citationKey })
    .from(schema.citations)
    .where(eq(schema.citations.messageId, assistantMessageId));
  assert.deepEqual(records.map((record) => record.citationKey).sort(), [
    "c2",
    "c3",
    "c4",
  ]);

  // The resume opened with the paused registry and the ids its text cites.
  assert.equal(opened.length, 1);
  const [continued] = opened;
  assert.equal(continued?.type, "citations");
  if (continued?.type === "citations") {
    assert.deepEqual(citationKeys(continued.availableCitations), [
      "c1",
      "c2",
      "c3",
    ]);
    assert.deepEqual(citationKeys(continued.citations), ["c2", "c3"]);
  }
});
