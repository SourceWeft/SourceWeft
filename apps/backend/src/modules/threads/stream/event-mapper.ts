import type { DeepAgentTurnEvent } from "../agent/turn/runner";
import {
  agentQuestionRequestSchema,
  toolConfirmationRequestSchema,
} from "@sourceweft/contracts";
import { isArtifactProgressOutputType } from "@sourceweft/agent-tool-registry";
import type { ToolCallTrace } from "../turn/types";
import { toSseData } from "./helpers";

const MAX_SSE_TOOL_OUTPUT_CHARS = 12_000;
const MAX_SSE_TOOL_OUTPUT_ITEMS = 120;

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function truncateTextForSse(value: string) {
  if (value.length <= MAX_SSE_TOOL_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_SSE_TOOL_OUTPUT_CHARS).trimEnd()}\n\nOutput truncated for live display. Full output is available after completion.`;
}

function formatFileInfo(value: unknown) {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const path = typeof record.path === "string" ? record.path : null;
  if (!path) {
    return null;
  }

  const isDirectory = record.is_dir === true;
  const size = typeof record.size === "number" ? record.size : null;
  const details = [
    size !== null ? `${size} bytes` : null,
    isDirectory ? "directory" : null,
  ].filter((item): item is string => item !== null);

  return details.length > 0 ? `${path} (${details.join(", ")})` : path;
}

function formatGrepMatch(value: unknown) {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const path = typeof record.path === "string" ? record.path : null;
  const line = typeof record.line === "number" ? record.line : null;
  const text = typeof record.text === "string" ? record.text : null;
  if (!path || text === null) {
    return null;
  }

  return line === null ? `${path}: ${text}` : `${path}:${line}: ${text}`;
}

function extractToolConfirmationRequest(output: unknown): unknown | null {
  const record = toObjectRecord(output);
  const confirmation = toolConfirmationRequestSchema.safeParse(record);
  return confirmation.success ? confirmation.data : null;
}

function extractUserQuestionRequest(output: unknown): unknown | null {
  const record = toObjectRecord(output);
  const question = agentQuestionRequestSchema.safeParse(record);
  return question.success ? question.data : null;
}

function isRedactedSkillInstructionRead(output: unknown) {
  const record = toObjectRecord(output);
  return record?.type === "skill_instruction_read" && record.redacted === true;
}

/**
 * Whether a structured tool output belongs to a capability that reports
 * artifact progress. Such records are forwarded to the client verbatim instead
 * of being summarized, because the client renders them as a progress block.
 * The registry answers which `type` values those are, so adding a deliverable
 * capability needs no edit here.
 */
function isArtifactProgressToolOutputRecord(record: Record<string, unknown>) {
  return isArtifactProgressOutputType(
    typeof record.type === "string" ? record.type : null,
  );
}

function parseJsonObjectStringForSse(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return toObjectRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

export function normalizeToolOutputForSse(output: unknown): unknown {
  if (output === null || output === undefined) {
    return null;
  }

  if (isRedactedSkillInstructionRead(output)) {
    return {
      type: "skill_instruction_read",
      redacted: true,
    };
  }

  const confirmation = extractToolConfirmationRequest(output);
  if (confirmation) {
    return confirmation;
  }

  const question = extractUserQuestionRequest(output);
  if (question) {
    return question;
  }

  if (typeof output === "string") {
    const parsedString = parseJsonObjectStringForSse(output);
    if (parsedString && isArtifactProgressToolOutputRecord(parsedString)) {
      return parsedString;
    }
    return truncateTextForSse(output);
  }

  if (Array.isArray(output)) {
    const visible = output.slice(0, MAX_SSE_TOOL_OUTPUT_ITEMS);
    return visible.length === output.length
      ? visible
      : [
          ...visible,
          `Output truncated for live display. ${output.length - visible.length} additional items are available after completion.`,
        ];
  }

  const record = toObjectRecord(output);
  if (!record) {
    return output;
  }

  if (isArtifactProgressToolOutputRecord(record)) {
    return record;
  }

  if (typeof record.content === "string") {
    const parsedContent = parseJsonObjectStringForSse(record.content);
    if (parsedContent && isArtifactProgressToolOutputRecord(parsedContent)) {
      return parsedContent;
    }
    return {
      ...record,
      content: truncateTextForSse(record.content),
    };
  }

  if (Array.isArray(record.files)) {
    const lines = record.files
      .slice(0, MAX_SSE_TOOL_OUTPUT_ITEMS)
      .map(formatFileInfo)
      .filter((item): item is string => item !== null);
    if (record.files.length > lines.length) {
      lines.push(
        `Output truncated for live display. ${record.files.length - lines.length} additional entries are available after completion.`,
      );
    }

    return { content: truncateTextForSse(lines.join("\n")) };
  }

  if (Array.isArray(record.matches)) {
    const lines = record.matches
      .slice(0, MAX_SSE_TOOL_OUTPUT_ITEMS)
      .map(formatGrepMatch)
      .filter((item): item is string => item !== null);
    if (record.matches.length > lines.length) {
      lines.push(
        `Output truncated for live display. ${record.matches.length - lines.length} additional matches are available after completion.`,
      );
    }

    return { content: truncateTextForSse(lines.join("\n")) };
  }

  if (typeof record.error === "string") {
    return { content: truncateTextForSse(record.error) };
  }

  return record;
}

function normalizeToolCallForSse(toolCall: ToolCallTrace) {
  return {
    ...toolCall,
    output: normalizeToolOutputForSse(toolCall.output),
  };
}

function normalizeReasoningSegmentForSse(
  segment: Extract<DeepAgentTurnEvent, { type: "reasoning" }>["segment"],
) {
  return {
    id: segment.id,
    sequence: segment.sequence,
    durationMs: segment.durationMs,
    phase: segment.phase,
    toolCallId: segment.toolCallId,
    tool: segment.tool,
  };
}

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

  if (event.type === "text-replace") {
    return toSseData({
      type: "text-replace",
      id: textId,
      text: event.text,
    });
  }

  if (event.type === "text-interrupted") {
    return toSseData({
      type: "text-interrupted",
      id: textId,
      reason: event.reason,
      toolCallId: event.toolCallId,
      tool: event.tool,
    });
  }

  if (event.type === "tool-call-start") {
    return toSseData({
      type: "tool-call-start",
      id: event.id,
      tool: event.tool,
      input: event.input,
      toolCall: normalizeToolCallForSse(event.toolCall),
    });
  }

  if (event.type === "tool-input-delta") {
    return toSseData({
      type: "tool-input-delta",
      id: event.id,
      tool: event.tool,
      input: event.input,
      toolCall: normalizeToolCallForSse(event.toolCall),
    });
  }

  if (event.type === "tool-call-event") {
    return toSseData({
      type: "tool-call-event",
      id: event.id,
      tool: event.tool,
      data: event.data,
      toolCall: normalizeToolCallForSse(event.toolCall),
    });
  }

  if (event.type === "tool-call-result") {
    return toSseData({
      type: "tool-call-result",
      id: event.id,
      tool: event.tool,
      input: event.input,
      output: normalizeToolOutputForSse(event.output),
      latencyMs: event.latencyMs,
      toolCall: normalizeToolCallForSse(event.toolCall),
      ...(event.query ? { query: event.query } : {}),
      ...(typeof event.hitCount === "number"
        ? { hitCount: event.hitCount }
        : {}),
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
      toolCall: normalizeToolCallForSse(event.toolCall),
    });
  }

  if (event.type === "tool-call-end") {
    return toSseData({
      type: "tool-call-end",
      id: event.id,
      tool: event.tool,
      status: event.status,
      latencyMs: event.latencyMs,
      toolCall: normalizeToolCallForSse(event.toolCall),
    });
  }

  if (event.type === "thinking-step") {
    return toSseData({
      type: "thinking-step",
      step: event.step,
    });
  }

  if (event.type === "reasoning") {
    return toSseData({
      type: "reasoning",
      reasoning: event.reasoning,
      segment: normalizeReasoningSegmentForSse(event.segment),
    });
  }

  if (event.type === "citations") {
    return toSseData({
      type: "citations",
      citations: event.citations,
      ...(event.availableCitations
        ? { availableCitations: event.availableCitations }
        : {}),
    });
  }

  // Unhandled event types produce no SSE frame. Previously this fell through to
  // the citations branch, so any new event variant was mis-emitted as a broken
  // `citations` event; returning null lets callers skip it safely instead.
  return null;
}
