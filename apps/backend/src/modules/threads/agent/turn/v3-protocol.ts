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
import { stringifyAgentMessageContent } from "./content";
import { toObjectRecord } from "../../../../shared/records";

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
  readonly interrupts: ReadonlyArray<{
    interruptId?: string;
    payload?: unknown;
  }>;
  readonly output: Promise<unknown>;
};

/**
 * Adopt a raw `streamEvents(…, { version: "v3" })` result as the run stream,
 * and make its per-tool `output` promises safe.
 *
 * langchain's v3 tool-call transformer keeps a `toolCalls` channel beside the
 * event stream; every entry carries an `output` promise that it REJECTS when
 * the tool errors. We read events, never those promises — so a tool that threw
 * (a sandbox that could not be reached, say) left a rejected promise nobody
 * handled, and Node treats that as fatal: one failed tool call in one turn took
 * the whole process down, for every user. The event stream already delivers the
 * failure (`tool-error`), so the promise's copy of it is observed and dropped.
 */
export function adoptV3RunStream(raw: unknown): V3RunStream {
  const toolCalls = (raw as { toolCalls?: unknown } | null)?.toolCalls;
  if (
    toolCalls &&
    typeof (toolCalls as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  ) {
    void (async () => {
      for await (const call of toolCalls as AsyncIterable<{
        output?: Promise<unknown>;
      }>) {
        call?.output?.catch(() => undefined);
      }
    })().catch(() => undefined);
  }
  return raw as V3RunStream;
}

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
function errorMessageContent(content: unknown): string {
  const text = stringifyAgentMessageContent(content).trim();
  if (text.length > 0) {
    return text;
  }
  try {
    const serialized = JSON.stringify(content);
    return serialized && serialized !== "{}"
      ? serialized
      : "Tool execution failed.";
  } catch {
    return "Tool execution failed.";
  }
}

function extractToolFinishedResult(output: unknown): {
  error: string | null;
  output: unknown;
} {
  const record = toObjectRecord(output);
  const kwargs = toObjectRecord(record?.kwargs);
  if (record && record.lc !== undefined && kwargs) {
    const content = parseMaybeJson(kwargs.content);
    if (kwargs.status === "error") {
      return {
        error: errorMessageContent(content),
        output: content,
      };
    }
    if (kwargs.artifact !== undefined && kwargs.artifact !== null) {
      return { error: null, output: kwargs.artifact };
    }
    return { error: null, output: content };
  }
  return { error: null, output };
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
    case "tool-finished": {
      const finished = extractToolFinishedResult(record.output);
      if (finished.error !== null) {
        return {
          event: "on_tool_error",
          name,
          toolCallId,
          error: finished.error,
        };
      }
      return {
        event: "on_tool_end",
        name,
        toolCallId,
        output: finished.output,
      };
    }
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
    return [
      [{ role: "assistant", content: "", reasoning: delta.reasoning }, {}],
    ];
  }
  // block-delta (tool_call_chunk args) and data-delta: not text/reasoning.
  return [];
}

/**
 * Extract a streaming tool-call argument fragment from a v3 `messages`
 * content-block-delta. These are the partial tool_call_chunks
 * ({@link adaptMessagesEvent} intentionally leaves them for this dedicated path)
 * that carry incremental arg JSON (`args` is a substring, concatenated by
 * `index`). The runner accumulates these to surface incremental write_file
 * `content` before the authoritative fully-formed call arrives via the `tools`
 * method. Returns null for any non tool_call_chunk delta.
 */
export function adaptToolArgDelta(
  data: unknown,
): { index: number; id?: string; name?: string; args: string } | null {
  const record = toObjectRecord(data);
  if (!record || record.event !== "content-block-delta") {
    return null;
  }
  const delta = toObjectRecord(record.delta);
  if (!delta || delta.type !== "block-delta") {
    return null;
  }
  const fields = toObjectRecord(delta.fields);
  if (!fields || fields.type !== "tool_call_chunk") {
    return null;
  }
  const blockIndex =
    typeof record.index === "number"
      ? record.index
      : typeof fields.index === "number"
        ? fields.index
        : 0;
  return {
    index: blockIndex,
    ...(typeof fields.id === "string" && fields.id.length > 0
      ? { id: fields.id }
      : {}),
    ...(typeof fields.name === "string" && fields.name.length > 0
      ? { name: fields.name }
      : {}),
    args: typeof fields.args === "string" ? fields.args : "",
  };
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
 *
 * An interrupt raised inside a `task` delegate is reported twice under one id —
 * once by the delegate's subgraph and once as it bubbles through the parent —
 * so entries are collapsed by id; otherwise one pause would open two
 * confirmations.
 */
export function interruptsToLegacyUpdatesPayload(
  interrupts: ReadonlyArray<{ interruptId?: string; payload?: unknown }>,
): { __interrupt__: Array<{ id?: string; value: unknown }> } {
  const seenIds = new Set<string>();
  const unique = interrupts.filter((entry) => {
    if (!entry.interruptId) {
      return true;
    }
    if (seenIds.has(entry.interruptId)) {
      return false;
    }
    seenIds.add(entry.interruptId);
    return true;
  });
  return {
    __interrupt__: unique.map((entry) => ({
      ...(entry.interruptId ? { id: entry.interruptId } : {}),
      value: entry.payload,
    })),
  };
}

/**
 * Whether a v3 `tool-error` message is a LangGraph interrupt passing through the
 * tool rather than a failure. v3 keeps only an error's message, and a
 * `GraphInterrupt`'s message is `JSON.stringify(interrupts)` — a non-empty array
 * of `{ id, value }`. That is what a `task` call carries while its delegate
 * waits for approval, and what `askUser` carries while it waits for an answer.
 */
export function isSerializedInterruptMessage(message: unknown): boolean {
  if (typeof message !== "string" || !message.trimStart().startsWith("[")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((entry) => {
      const record = toObjectRecord(entry);
      return (
        typeof record?.id === "string" &&
        record.id.length > 0 &&
        "value" in record
      );
    })
  );
}
