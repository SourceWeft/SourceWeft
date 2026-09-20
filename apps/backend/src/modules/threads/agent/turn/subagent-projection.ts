/**
 * Projects a `task` delegate's run into a child thread of its own.
 *
 * A delegate is stateless to deepagents: `task` invokes the sub-agent graph
 * inside the tool, hands the parent a single ToolMessage, and keeps no
 * checkpoint (verified: only the root namespace is ever saved). What the user
 * sees today is therefore one inline card. This module turns the same run into
 * a conversation the user can open and continue, purely as a persistence
 * projection of the events the runner already receives:
 *
 * - when the parent's `task` call starts, a child `threads` row is created
 *   (nested under the parent, driven by the matching built-in persona);
 * - the delegate's own `messages` / `tools` stream events (depth-2 namespace,
 *   the ones the runner otherwise drops) are folded into a transcript;
 * - when the `task` call finishes, the transcript is written as the child
 *   thread's messages and seeded into the child's own checkpoint, so the next
 *   user message there continues from what the delegate did.
 *
 * Nothing here yields a stream event: the client wire stays byte-for-byte as
 * before. The parent keeps receiving only the delegate's report (context
 * quarantine is untouched), and any failure below is logged, never thrown into
 * the parent turn.
 *
 * Continuation design: the child thread's later turns run the persona graph on
 * `buildAgentConfig(childThreadId)`, whose PostgresSaver checkpoint is empty for
 * a projected thread. `updateState(config, { messages })` on the parent's
 * compiled graph writes those messages into the child's state channels (same
 * checkpointer, same deepagents state family; see `seedChildCheckpointWith`),
 * which is exactly what a resumed turn loads before appending the new user
 * message. The seeded checkpoint is also recorded on the last projected
 * assistant message (`agentCheckpoint.final`) so the turn preparer pins to it
 * like any other continue turn. Rebuilding history from the messages table
 * instead would need the preparer to learn a second input path; seeding keeps
 * the one it has.
 */
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { logger } from "../../../../shared/logger";
import { toObjectRecord } from "../../../../shared/records";
import type { ThreadRecord } from "../../../content/types";
import type {
  AgentCheckpointRef,
  MessageRenderBlock,
  PreparedThreadTurn,
  ToolCallTrace,
} from "../..";
import { buildAgentConfig } from "..";
import { createMessageRecord } from "../../message-repository";
import { createThreadRecord } from "../../thread/repository";
import { findPersona } from "../personas";
import { checkpointRefFromConfig } from "./checkpoint";
import { namespaceSegments } from "./subagent-namespace";

/** deepagents' delegation tool. */
export const TASK_TOOL_NAME = "task";

const NAMESPACE_KEY_SEP = " ";
const OUTPUT_MARKER_KEY = "sourceweft";
const MAX_TITLE_CHARS = 60;
const MAX_TOOL_CONTENT_CHARS = 100_000;
const MISSING_TOOL_RESULT = "No result was recorded for this call.";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The child thread's title: the brief's first sentence, capped. Mirrors the
 * web's delegate chip title so the sidebar row and the inline card agree.
 */
export function deriveSubagentThreadTitle(
  brief: string,
  fallback: string,
): string {
  const firstLine = brief
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return fallback;
  }
  const sentenceEnd = firstLine.search(/[。.!?！？]/u);
  let title = sentenceEnd > 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  if (title.length > MAX_TITLE_CHARS) {
    title = `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
  }
  return title.length > 0 ? title : fallback;
}

/**
 * Tag the `task` tool's result with the child thread it was projected into.
 * The result is deepagents' serialized `Command` object; the client reads the
 * report from `update.messages` and ignores siblings, so an extra namespaced
 * key rides along without a new event or field. A non-object result (the rare
 * plain-string report) is left alone so its shape stays readable.
 */
export function attachChildThreadToTaskOutput(
  output: unknown,
  childThreadId: string,
): unknown {
  const record = toObjectRecord(output);
  if (!record) {
    // v3 hands the tool node's ToolMessage content through, so a delegate's
    // result is usually the plain report string. Wrap it under `report` (which
    // the client's report reader also understands) so the id has a home.
    return {
      report: typeof output === "string" ? output : (output ?? null),
      [OUTPUT_MARKER_KEY]: { childThreadId },
    };
  }
  return {
    ...record,
    [OUTPUT_MARKER_KEY]: {
      ...(toObjectRecord(record[OUTPUT_MARKER_KEY]) ?? {}),
      childThreadId,
    },
  };
}

export function readChildThreadIdFromTaskOutput(
  output: unknown,
): string | null {
  const marker = toObjectRecord(toObjectRecord(output)?.[OUTPUT_MARKER_KEY]);
  const childThreadId = marker?.childThreadId;
  return typeof childThreadId === "string" && childThreadId.length > 0
    ? childThreadId
    : null;
}

function readBrief(input: unknown): string {
  const description = toObjectRecord(input)?.description;
  return typeof description === "string" ? description.trim() : "";
}

function readSubagentType(input: unknown): string | undefined {
  const value = toObjectRecord(input)?.subagent_type;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringifyToolContent(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined || value === null) {
    text = "";
  } else {
    const record = toObjectRecord(value);
    if (record && typeof record.content === "string") {
      text = record.content;
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
  }
  return text.length > MAX_TOOL_CONTENT_CHARS
    ? `${text.slice(0, MAX_TOOL_CONTENT_CHARS)}…`
    : text;
}

// ---------------------------------------------------------------------------
// Transcript collector
// ---------------------------------------------------------------------------

export type TranscriptToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type TranscriptEntry =
  | {
      kind: "ai";
      text: string;
      toolCalls: TranscriptToolCall[];
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      content: string;
      status: "completed" | "error";
    };

/** The legacy tool payload shape {@link adaptToolsEvent} produces. */
export type SubagentToolPayload = {
  event: string;
  name: string;
  toolCallId: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

/**
 * Folds one delegate's v3 stream events into an ordered transcript. The model's
 * `messages` events segment assistant turns (`message-start` opens one, text
 * deltas fill it, `message-finish` closes it); `tools` events attach the tool
 * calls of the current assistant turn and append their results. deepagents
 * runs all of a turn's tools before the next model call, so "current turn" is
 * simply the last assistant entry opened by `message-start`.
 */
export class SubagentTranscriptCollector {
  readonly entries: TranscriptEntry[] = [];
  private currentAi: Extract<TranscriptEntry, { kind: "ai" }> | null = null;
  private currentAiOpen = false;

  private openAi() {
    const entry = { kind: "ai" as const, text: "", toolCalls: [] };
    this.entries.push(entry);
    this.currentAi = entry;
    this.currentAiOpen = true;
    return entry;
  }

  observeMessages(data: unknown) {
    const record = toObjectRecord(data);
    const event = typeof record?.event === "string" ? record.event : "";
    if (event === "message-start") {
      this.openAi();
      return;
    }
    if (event === "message-finish") {
      this.currentAiOpen = false;
      return;
    }
    if (event !== "content-block-delta") {
      return;
    }
    const delta = toObjectRecord(record?.delta);
    if (
      delta?.type !== "text-delta" ||
      typeof delta.text !== "string" ||
      delta.text.length === 0
    ) {
      return;
    }
    const target =
      this.currentAi && this.currentAiOpen ? this.currentAi : this.openAi();
    target.text += delta.text;
  }

  observeTool(payload: SubagentToolPayload) {
    if (payload.event === "on_tool_start") {
      const target = this.currentAi ?? this.openAi();
      if (!target.toolCalls.some((call) => call.id === payload.toolCallId)) {
        target.toolCalls.push({
          id: payload.toolCallId,
          name: payload.name,
          args: toObjectRecord(payload.input) ?? {},
        });
      }
      return;
    }
    if (payload.event === "on_tool_end") {
      this.entries.push({
        kind: "tool",
        id: payload.toolCallId,
        name: payload.name,
        content: stringifyToolContent(payload.output),
        status: "completed",
      });
      return;
    }
    if (payload.event === "on_tool_error") {
      this.entries.push({
        kind: "tool",
        id: payload.toolCallId,
        name: payload.name,
        content:
          stringifyToolContent(payload.error) || "Tool execution failed.",
        status: "error",
      });
    }
  }

  hasAssistantTurns() {
    return this.entries.some((entry) => entry.kind === "ai");
  }
}

/**
 * The transcript as LangChain messages, in the shape a checkpoint holds: the
 * brief as the human turn, every assistant turn with its tool calls, a
 * ToolMessage for each call (synthesized when the stream never delivered one,
 * since providers reject a dangling tool call), and the report as the closing
 * assistant turn when the delegate's last words were not already captured.
 */
export function transcriptToMessages(input: {
  brief: string;
  entries: readonly TranscriptEntry[];
  report: string | null;
}): BaseMessage[] {
  const messages: BaseMessage[] = [new HumanMessage(input.brief)];
  const answered = new Set(
    input.entries
      .filter((entry) => entry.kind === "tool")
      .map((entry) => entry.id),
  );
  for (const entry of input.entries) {
    if (entry.kind === "ai") {
      messages.push(
        new AIMessage({
          content: entry.text,
          tool_calls: entry.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.args,
            type: "tool_call" as const,
          })),
        }),
      );
      for (const call of entry.toolCalls) {
        if (!answered.has(call.id)) {
          messages.push(
            new ToolMessage({
              tool_call_id: call.id,
              name: call.name,
              content: MISSING_TOOL_RESULT,
              status: "error",
            }),
          );
        }
      }
      continue;
    }
    messages.push(
      new ToolMessage({
        tool_call_id: entry.id,
        name: entry.name,
        content: entry.content,
        status: entry.status === "error" ? "error" : "success",
      }),
    );
  }
  const last = messages[messages.length - 1];
  const lastIsAnswer =
    last instanceof AIMessage &&
    (!Array.isArray(last.tool_calls) || last.tool_calls.length === 0);
  if (!lastIsAnswer) {
    messages.push(new AIMessage({ content: input.report ?? "" }));
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Child thread + persistence
// ---------------------------------------------------------------------------

type ThreadScope = {
  teamId: string;
  workspaceId: string;
};

/**
 * Create the child thread a delegate's run is projected into. Nested one level
 * under the top-level thread (a persona thread's own delegates attach to its
 * parent, never deeper), driven by the built-in persona whose slug is the
 * delegate's `subagent_type`, and shown to the parent's audience.
 */
export async function createChildThreadForDelegate(input: {
  parent: Pick<
    ThreadRecord,
    | "id"
    | "teamId"
    | "workspaceId"
    | "visibility"
    | "parentThreadId"
    | "modelSettings"
  >;
  userId: string;
  subagentType: string | undefined;
  brief: string;
}) {
  const persona = findPersona(input.subagentType);
  return createThreadRecord({
    teamId: input.parent.teamId,
    workspaceId: input.parent.workspaceId,
    title: deriveSubagentThreadTitle(
      input.brief,
      persona?.name ?? input.subagentType ?? "Sub-agent",
    ),
    createdBy: input.userId,
    modelSettings: input.parent.modelSettings,
    visibility: input.parent.visibility === "private" ? "private" : "workspace",
    parentThreadId: input.parent.parentThreadId ?? input.parent.id,
    personaId: persona?.slug ?? null,
    origin: "subagent",
  });
}

export type SeedChildCheckpoint = (input: {
  childThreadId: string;
  messages: BaseMessage[];
}) => Promise<AgentCheckpointRef | null>;

/**
 * Seed a child thread's checkpoint through a compiled deepagents graph that
 * shares the thread checkpointer. On a thread with no checkpoint, LangGraph
 * attributes an `updateState` without `asNode` to the graph's `__start__`
 * node, whose writers fan the values out into the state channels — so the
 * messages land in `messages` itself, which is what the child's next turn
 * loads before it appends the new user message. (Writing "as input" instead
 * would only park the values in the start channel, where the next turn's own
 * input replaces them.)
 */
export function seedChildCheckpointWith(agent: unknown): SeedChildCheckpoint {
  return async ({ childThreadId, messages }) => {
    const graph = agent as {
      updateState?: (config: unknown, values: unknown) => Promise<unknown>;
    };
    if (typeof graph?.updateState !== "function") {
      return null;
    }
    const config = await graph.updateState(buildAgentConfig(childThreadId), {
      messages,
    });
    return checkpointRefFromConfig(config);
  };
}

function textBlock(text: string): MessageRenderBlock {
  return { id: "text-1", type: "text", text };
}

function toolBlock(toolCallId: string): MessageRenderBlock {
  return { id: `tool-${toolCallId}`, type: "tool", toolCallId };
}

function synthesizeToolTrace(
  call: TranscriptToolCall,
  result: Extract<TranscriptEntry, { kind: "tool" }> | undefined,
): ToolCallTrace {
  return {
    id: call.id,
    tool: call.name,
    input: call.args,
    output: result?.content ?? null,
    status: result?.status ?? "completed",
    latencyMs: null,
    error: result?.status === "error" ? result.content : null,
    sequence: 0,
  };
}

/**
 * Write the transcript as the child thread's messages and seed its checkpoint.
 * The brief is the user turn; each assistant turn keeps its tool calls in the
 * same `toolCalls` / `renderBlocks` metadata the message list renders for any
 * turn (the runner's own traces where it recorded them, since it already
 * processed the delegate's tool events; a synthesized trace otherwise). The
 * seeded checkpoint is stamped on the last assistant row so the turn preparer
 * continues from it.
 */
export async function persistSubagentTranscript(input: {
  scope: ThreadScope;
  childThreadId: string;
  parentThreadId: string;
  taskCallId: string;
  subagentType: string | undefined;
  brief: string;
  report: string | null;
  entries: readonly TranscriptEntry[];
  toolTraces: ReadonlyMap<string, ToolCallTrace>;
  modelAlias: string | null;
  createdBy: string;
  seedCheckpoint: SeedChildCheckpoint;
}) {
  const projection = {
    source: "subagent_projection",
    subagent: {
      parentThreadId: input.parentThreadId,
      taskCallId: input.taskCallId,
      ...(input.subagentType ? { subagentType: input.subagentType } : {}),
    },
  };

  let checkpoint: AgentCheckpointRef | null = null;
  try {
    checkpoint = await input.seedCheckpoint({
      childThreadId: input.childThreadId,
      messages: transcriptToMessages({
        brief: input.brief,
        entries: input.entries,
        report: input.report,
      }),
    });
  } catch (error) {
    logger.warn("Failed to seed sub-agent child thread checkpoint", {
      childThreadId: input.childThreadId,
      taskCallId: input.taskCallId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await createMessageRecord({
    teamId: input.scope.teamId,
    workspaceId: input.scope.workspaceId,
    threadId: input.childThreadId,
    role: "user",
    content: input.brief,
    createdBy: input.createdBy,
    metadata: { ...projection },
  });

  const resultsById = new Map(
    input.entries
      .filter(
        (entry): entry is Extract<TranscriptEntry, { kind: "tool" }> =>
          entry.kind === "tool",
      )
      .map((entry) => [entry.id, entry] as const),
  );
  const assistantTurns = input.entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: "ai" }> =>
      entry.kind === "ai",
  );
  const rows: Array<{ content: string; toolCalls: ToolCallTrace[] }> =
    assistantTurns.map((turn) => ({
      content: turn.text,
      toolCalls: turn.toolCalls.map(
        (call) =>
          input.toolTraces.get(call.id) ??
          synthesizeToolTrace(call, resultsById.get(call.id)),
      ),
    }));
  const lastRow = rows[rows.length - 1];
  const reportCaptured =
    lastRow !== undefined &&
    lastRow.toolCalls.length === 0 &&
    lastRow.content.trim().length > 0;
  if (!reportCaptured) {
    rows.push({ content: input.report ?? "", toolCalls: [] });
  }

  for (const [index, row] of rows.entries()) {
    const isLast = index === rows.length - 1;
    const renderBlocks: MessageRenderBlock[] = [
      ...(row.content.length > 0 ? [textBlock(row.content)] : []),
      ...row.toolCalls.map((call) => toolBlock(call.id)),
    ];
    await createMessageRecord({
      teamId: input.scope.teamId,
      workspaceId: input.scope.workspaceId,
      threadId: input.childThreadId,
      role: "assistant",
      content: row.content,
      createdBy: null,
      model: input.modelAlias,
      metadata: {
        ...projection,
        modelAlias: input.modelAlias,
        toolCalls: row.toolCalls,
        renderBlocks,
        thinkingSteps: [],
        traceParts: [],
        versionOf: null,
        ...(isLast
          ? {
              agentCheckpoint: {
                beforeInput: null,
                beforeAssistant: null,
                resume: null,
                final: checkpoint,
              },
            }
          : {}),
      },
    });
  }

  return { checkpoint, assistantRows: rows.length };
}

// ---------------------------------------------------------------------------
// Runner-facing projector
// ---------------------------------------------------------------------------

type TrackedTask = {
  taskCallId: string;
  namespaceKey: string;
  subagentType: string | undefined;
  brief: string;
  collector: SubagentTranscriptCollector;
  childThread: Promise<ThreadRecord | null>;
  finished: boolean;
};

export type SubagentProjector = ReturnType<typeof createSubagentProjector>;

function keyOf(segments: readonly string[]) {
  return segments.join(NAMESPACE_KEY_SEP);
}

/**
 * The runner's handle. Call sites are the three places the runner already
 * distinguishes: the parent's `task` tool start/end, and the delegate's own
 * (depth-2) events. Every method is fire-safe: a projection failure is logged
 * and the parent turn proceeds exactly as if projection did not exist.
 */
export function createSubagentProjector(input: {
  prepared: PreparedThreadTurn;
  toolTraces: ReadonlyMap<string, ToolCallTrace>;
  seedCheckpoint: SeedChildCheckpoint;
  createChildThread?: typeof createChildThreadForDelegate;
  persist?: typeof persistSubagentTranscript;
}) {
  const createChildThread =
    input.createChildThread ?? createChildThreadForDelegate;
  const persist = input.persist ?? persistSubagentTranscript;
  const tasksByCallId = new Map<string, TrackedTask>();
  const taskCallIdByNamespaceKey = new Map<string, string>();
  const pending = new Set<Promise<unknown>>();
  const scope = {
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
  };
  const logContext = () => ({
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    userId: input.prepared.userId,
  });

  function track(promise: Promise<unknown>) {
    const tracked = promise.finally(() => {
      pending.delete(tracked);
    });
    pending.add(tracked);
    return tracked;
  }

  function taskForChildNamespace(namespace: unknown): TrackedTask | null {
    const segments = namespaceSegments(namespace);
    if (segments.length !== 2) {
      // Depth 1 is the parent; depth 3+ is a delegate's own delegate, which
      // surfaces in the child transcript through the child's `task` call.
      return null;
    }
    const taskCallId = taskCallIdByNamespaceKey.get(
      keyOf(segments.slice(0, -1)),
    );
    return taskCallId ? (tasksByCallId.get(taskCallId) ?? null) : null;
  }

  return {
    /** The parent's `task` tool call started: open a child thread for it. */
    startTask(task: {
      taskCallId: string;
      namespace: unknown;
      input: unknown;
    }) {
      const segments = namespaceSegments(task.namespace);
      const brief = readBrief(task.input);
      const subagentType = readSubagentType(task.input);
      const childThread = createChildThread({
        parent: input.prepared.thread,
        userId: input.prepared.userId,
        subagentType,
        brief,
      }).catch((error: unknown) => {
        logger.warn("Failed to create sub-agent child thread", {
          ...logContext(),
          taskCallId: task.taskCallId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      track(childThread);
      const tracked: TrackedTask = {
        taskCallId: task.taskCallId,
        namespaceKey: keyOf(segments),
        subagentType,
        brief,
        collector: new SubagentTranscriptCollector(),
        childThread,
        finished: false,
      };
      tasksByCallId.set(task.taskCallId, tracked);
      if (segments.length > 0) {
        taskCallIdByNamespaceKey.set(tracked.namespaceKey, task.taskCallId);
      }
    },

    /** A delegate's model event (the runner drops these from the client). */
    observeMessages(namespace: unknown, data: unknown) {
      taskForChildNamespace(namespace)?.collector.observeMessages(data);
    },

    /** A delegate's tool event, in the legacy payload shape. */
    observeTool(namespace: unknown, payload: Record<string, unknown>) {
      const task = taskForChildNamespace(namespace);
      if (!task) {
        return;
      }
      const toolCallId = payload.toolCallId;
      const event = payload.event;
      if (typeof toolCallId !== "string" || typeof event !== "string") {
        return;
      }
      task.collector.observeTool({
        event,
        name: typeof payload.name === "string" ? payload.name : "tool",
        toolCallId,
        input: payload.input,
        output: payload.output,
        error: payload.error,
      });
    },

    /**
     * The parent's `task` call finished: persist the transcript into the child
     * thread. Resolves to the child thread id (so the caller can tag the tool
     * result) or null when nothing was projected.
     */
    async finishTask(task: {
      taskCallId: string;
      report: string | null;
    }): Promise<string | null> {
      const tracked = tasksByCallId.get(task.taskCallId);
      if (!tracked || tracked.finished) {
        return null;
      }
      tracked.finished = true;
      const childThread = await tracked.childThread;
      if (!childThread) {
        return null;
      }
      track(
        persist({
          scope,
          childThreadId: childThread.id,
          parentThreadId:
            childThread.parentThreadId ?? input.prepared.thread.id,
          taskCallId: tracked.taskCallId,
          subagentType: tracked.subagentType,
          brief: tracked.brief,
          report: task.report,
          entries: tracked.collector.entries,
          toolTraces: input.toolTraces,
          modelAlias: input.prepared.modelAlias ?? null,
          createdBy: input.prepared.userId,
          seedCheckpoint: input.seedCheckpoint,
        }).catch((error: unknown) => {
          logger.warn("Failed to persist sub-agent transcript", {
            ...logContext(),
            taskCallId: task.taskCallId,
            childThreadId: childThread.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
      return childThread.id;
    },

    /** Wait for every projection write to settle (called before the turn ends). */
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}

/**
 * The delegate's report as the parent sees it: the last ToolMessage inside the
 * serialized `Command` the `task` tool returns (or a plain string).
 */
export function readTaskReport(output: unknown): string | null {
  if (typeof output === "string") {
    return output.length > 0 ? output : null;
  }
  const record = toObjectRecord(output);
  if (typeof record?.report === "string") {
    return record.report.length > 0 ? record.report : null;
  }
  const update = toObjectRecord(record?.update);
  const messages = Array.isArray(update?.messages) ? update.messages : [];
  const last = toObjectRecord(messages[messages.length - 1]);
  const kwargs = toObjectRecord(last?.kwargs ?? last?.lc_kwargs);
  const content = kwargs?.content;
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const record = toObjectRecord(part);
        return typeof record?.text === "string" ? record.text : "";
      })
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}
