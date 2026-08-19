/**
 * Adapters from deepagents `streamEvents(…, { version: "v3" })` ProtocolEvents to
 * the internal payload shapes the turn handlers already consume.
 *
 * The turn pipeline was written against LangGraph's raw multi-mode
 * `agent.stream(streamMode:[…], subgraphs:true)` tuples. v3 replaces those with a
 * single normalized ProtocolEvent stream (see @langchain/protocol): the same
 * `method` names (`messages`/`tools`/`custom`/`updates`/`checkpoints`) but a
 * different, AG-UI-style `params.data` schema. Rather than rewrite every
 * downstream normalizer/presenter, these thin adapters translate each v3 event
 * back into the legacy shape the existing handlers expect, so the battle-tested
 * tool/message/citation logic keeps working unchanged.
 *
 * Namespaces are identical to the old `subgraphs: true` scheme
 * (`["tools:<branchId>", …]`) because the v3 run-stream is itself built on
 * `graph.stream({ subgraphs: true })` — so sub-agent grouping in
 * subagent-namespace.ts is reused as-is.
 */
import { toObjectRecord } from "./content";

/** One event from `run` (the DeepAgentRunStream is an AsyncIterable of these). */
export type V3ProtocolEvent = {
  method: string;
  params?: {
    namespace?: unknown;
    node?: string;
    data?: unknown;
    timestamp?: number;
  };
};

/** The subset of the deepagents v3 run stream the runner relies on. */
export type V3RunStream = AsyncIterable<V3ProtocolEvent> & {
  readonly interrupted: boolean;
  readonly interrupts: ReadonlyArray<{ interruptId?: string; payload?: unknown }>;
  readonly output: Promise<unknown>;
};

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * v3 `tool-finished` carries the serialized ToolMessage (lc-constructor form).
 * The downstream normalizers expect the tool's actual return value: prefer the
 * structured `artifact` (content_and_artifact tools), else the parsed `content`.
 */
function extractToolFinishedOutput(output: unknown): unknown {
  const record = toObjectRecord(output);
  const kwargs = toObjectRecord(record?.kwargs);
  if (record && record.lc !== undefined && kwargs) {
    if (kwargs.artifact !== undefined && kwargs.artifact !== null) {
      return kwargs.artifact;
    }
    return parseMaybeJson(kwargs.content);
  }
  return output;
}

/**
 * Translate a v3 `tools` ProtocolEvent's `data` into the legacy `on_tool_*`
 * payload consumed by {@link resolveToolsStreamToolCall}. `tool-finished` /
 * `tool-error` omit the tool name, so it is recovered from
 * `toolNameByCallId` (populated on `tool-started`). Returns `null` for events
 * without a resolvable `tool_call_id` or an unrecognized shape.
 */
export function adaptToolsEvent(
  data: unknown,
  toolNameByCallId: Map<string, string>,
): Record<string, unknown> | null {
  const record = toObjectRecord(data);
  if (!record) {
    return null;
  }
  const event = typeof record.event === "string" ? record.event : "";
  const toolCallId =
    typeof record.tool_call_id === "string" && record.tool_call_id.length > 0
      ? record.tool_call_id
      : undefined;
  if (!toolCallId) {
    return null;
  }
  const nameFromData =
    typeof record.tool_name === "string" && record.tool_name.length > 0
      ? record.tool_name
      : undefined;
  if (nameFromData) {
    toolNameByCallId.set(toolCallId, nameFromData);
  }
  const name = nameFromData ?? toolNameByCallId.get(toolCallId) ?? "tool";

  switch (event) {
    case "tool-started":
      return {
        event: "on_tool_start",
        name,
        toolCallId,
        input: parseMaybeJson(record.input),
      };
    case "tool-output-delta":
      return {
        event: "on_tool_event",
        name,
        toolCallId,
        data: record.delta,
      };
    case "tool-finished":
      return {
        event: "on_tool_end",
        name,
        toolCallId,
        output: extractToolFinishedOutput(record.output),
      };
    case "tool-error":
      return {
        event: "on_tool_error",
        name,
        toolCallId,
        error:
          typeof record.message === "string"
            ? record.message
            : String(record.message ?? ""),
      };
    default:
      return null;
  }
}

/**
 * Translate a v3 `messages` ProtocolEvent's `data` (content-block protocol) into
 * zero or more synthetic AIMessageChunk-like `[chunk, meta]` payloads for
 * {@link handleMessagesStreamChunk}. Only text and reasoning deltas surface here;
 * tool-call chunks are intentionally dropped because the `tools` method now
 * delivers every tool call reliably (with its `tool_call_id`).
 */
export function adaptMessagesEvent(
  data: unknown,
): Array<[Record<string, unknown>, Record<string, unknown>]> {
  const record = toObjectRecord(data);
  if (!record) {
    return [];
  }
  const event = typeof record.event === "string" ? record.event : "";
  if (event !== "content-block-delta") {
    // message-start / content-block-start / content-block-finish / message-finish
    // / error carry no incremental text or reasoning the pipeline consumes
    // (usage/finish are settled by the billing scope and final outcome).
    return [];
  }
  const delta = toObjectRecord(record.delta);
  const deltaType = typeof delta?.type === "string" ? delta.type : "";
  if (
    deltaType === "text-delta" &&
    typeof delta?.text === "string" &&
    delta.text.length > 0
  ) {
    return [[{ role: "assistant", content: delta.text }, {}]];
  }
  if (
    deltaType === "reasoning-delta" &&
    typeof delta?.reasoning === "string" &&
    delta.reasoning.length > 0
  ) {
    return [[{ role: "assistant", content: "", reasoning: delta.reasoning }, {}]];
  }
  // block-delta (tool_call_chunk args) and data-delta: not text/reasoning.
  return [];
}

/** v3 wraps custom `writer(...)` payloads as `{ payload: <data> }`; unwrap it. */
export function unwrapCustomEvent(data: unknown): unknown {
  const record = toObjectRecord(data);
  if (record && "payload" in record) {
    return record.payload;
  }
  return data;
}

/**
 * Reshape terminal `run.interrupts` (`[{ interruptId, payload }]`) into the
 * `{ __interrupt__: [{ id, value }] }` shape the existing HITL and askUser
 * handlers parse (they were written against the old `updates`-mode interrupt
 * chunk). This is what lets the interrupt handling move from mid-stream to the
 * clean post-drain `run.interrupted` surface without touching those handlers.
 */
export function interruptsToLegacyUpdatesPayload(
  interrupts: ReadonlyArray<{ interruptId?: string; payload?: unknown }>,
): { __interrupt__: Array<{ id?: string; value: unknown }> } {
  return {
    __interrupt__: interrupts.map((entry) => ({
      ...(entry.interruptId ? { id: entry.interruptId } : {}),
      value: entry.payload,
    })),
  };
}
