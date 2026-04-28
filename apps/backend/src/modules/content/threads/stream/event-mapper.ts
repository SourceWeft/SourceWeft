import type { DeepAgentTurnEvent } from "../../agent/turn/runner";
import { toSseData } from "./helpers";

export function mapDeepAgentEventToSse(
  event: Exclude<DeepAgentTurnEvent, { type: "done" }>,
  textId: string,
) {
  if (event.type === "text-delta") {
    return toSseData({
      type: "text-delta",
      id: textId,
      delta: event.delta,
    });
  }

  if (event.type === "tool-call-start") {
    return toSseData({
      type: "tool-call-start",
      id: event.id,
      tool: event.tool,
      input: event.input,
      toolCall: event.toolCall,
    });
  }

  if (event.type === "tool-call-event") {
    return toSseData({
      type: "tool-call-event",
      id: event.id,
      tool: event.tool,
      data: event.data,
      toolCall: event.toolCall,
    });
  }

  if (event.type === "tool-call-result") {
    return toSseData({
      type: "tool-call-result",
      id: event.id,
      tool: event.tool,
      input: event.input,
      output: event.output,
      latencyMs: event.latencyMs,
      toolCall: event.toolCall,
      ...(event.query ? { query: event.query } : {}),
      ...(typeof event.hitCount === "number" ? { hitCount: event.hitCount } : {}),
    });
  }

  if (event.type === "tool-call-error") {
    return toSseData({
      type: "tool-call-error",
      id: event.id,
      tool: event.tool,
      input: event.input,
      error: event.error,
      latencyMs: event.latencyMs,
      toolCall: event.toolCall,
    });
  }

  if (event.type === "tool-call-end") {
    return toSseData({
      type: "tool-call-end",
      id: event.id,
      tool: event.tool,
      status: event.status,
      latencyMs: event.latencyMs,
      toolCall: event.toolCall,
    });
  }

  if (event.type === "thinking-step") {
    return toSseData({
      type: "thinking-step",
      step: event.step,
    });
  }

  return toSseData({
    type: "citations",
    citations: event.citations,
  });
}
