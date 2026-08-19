import { parsePartialJson } from "@langchain/core/output_parsers";

import type { DeepAgentTurnEvent } from "./events";
import { sanitizeFilesystemToolInputForClient } from "./output-normalizer";
import type { TurnRuntime } from "./turn-runtime";

export type PartialToolArgStreamState = {
  id?: string;
  name?: string;
  args: string;
  lastContentLength: number;
};

/**
 * Tools whose partial args we surface incrementally, mapped to the arg field
 * carrying the authored code. Only write_file today — edit_file keeps its
 * atomic diff (its preview needs both old/new strings to render).
 */
const STREAMED_CONTENT_FIELD: Record<string, string> = {
  write_file: "content",
};

/**
 * Pull the streamable content string out of a (possibly partial) parsed args
 * object for a streamed tool. Returns null when the field isn't a string yet.
 */
export function extractStreamableContent(
  tool: string,
  parsedArgs: unknown,
): string | null {
  const field = STREAMED_CONTENT_FIELD[tool];
  if (!field || parsedArgs == null || typeof parsedArgs !== "object") {
    return null;
  }
  const value = (parsedArgs as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/**
 * Accumulate a streamed tool-arg fragment and, when it advances the authored
 * content of a streamed tool, emit an additive `tool-input-delta` so the client
 * can render the code as it is written. The authoritative fully-formed call
 * still arrives later via `tool-call-start` (same id), which replaces the
 * partial content — so this never double-counts or duplicates output.
 *
 * Uses LangChain's own `parsePartialJson` (the same parser `AIMessageChunk`
 * uses to collapse tool_call_chunks) rather than hand-scraping the JSON.
 */
export function* handleToolArgDeltaChunk(input: {
  delta: { index: number; id?: string; name?: string; args: string };
  runtime: TurnRuntime;
}): Generator<DeepAgentTurnEvent> {
  const { delta, runtime } = input;
  const slotKey = String(delta.index);
  const state =
    runtime.partialToolArgsBySlot.get(slotKey) ??
    ({ args: "", lastContentLength: 0 } as PartialToolArgStreamState);
  if (delta.id && !state.id) {
    state.id = delta.id;
  }
  if (delta.name && !state.name) {
    state.name = delta.name;
  }
  state.args += delta.args;
  runtime.partialToolArgsBySlot.set(slotKey, state);

  // Need the real tool-call id (so the client reconciles with tool-call-start)
  // and a tool we actually stream.
  if (!state.id || !state.name || !(state.name in STREAMED_CONTENT_FIELD)) {
    return;
  }
  // Once the tools method has promoted the authoritative call, stop streaming
  // partials for it.
  if (runtime.toolCallsById.has(state.id)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = parsePartialJson(state.args);
  } catch {
    return;
  }
  const content = extractStreamableContent(state.name, parsed);
  if (content === null || content.length <= state.lastContentLength) {
    return;
  }
  state.lastContentLength = content.length;

  const record =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const rawInput: Record<string, unknown> = {
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    content,
  };
  const clientInput = sanitizeFilesystemToolInputForClient(
    state.name,
    rawInput,
  );

  yield {
    type: "tool-input-delta",
    id: state.id,
    tool: state.name,
    input: clientInput,
    toolCall: {
      id: state.id,
      tool: state.name,
      input: clientInput,
      output: null,
      status: "running",
      latencyMs: null,
      error: null,
      sequence: runtime.resolveToolCallSequence(state.id),
    },
  };
}
