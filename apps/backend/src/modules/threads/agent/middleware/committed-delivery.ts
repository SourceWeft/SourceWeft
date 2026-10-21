import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getAgentToolDefinition } from "@sourceweft/agent-tool-registry";
import {
  readTerminalToolResult,
  type TerminalToolResult,
} from "@sourceweft/contracts/agent-tools";

/**
 * Tool-calling decisions a scope may still make after its latest committed
 * delivery. The next decision is the finalizing summary, without tools.
 */
export const COMMITTED_DELIVERY_TOOL_DECISION_LIMIT = 3;

const COMMITTED_DELIVERY_PROMPT = `Deliverable committed, finish now. A host-verified publisher receipt in this conversation confirms the deliverable was delivered. Reply to the user with a short summary of what was published and only the checks completed before publishing. Do not call more tools, re-verify, re-render or start new drafts; publish again only if the user explicitly asked for another revision. Tool-calling decisions left before this run is closed: `;

export type CommittedDelivery = {
  result: TerminalToolResult;
  /** Tool-calling model decisions after the latest newly committed version. */
  toolDecisionsSince: number;
};

/** Host tool output of a message; plain tool text is never result authority. */
export function readToolMessageResult(
  message: ToolMessage,
): Record<string, unknown> | null {
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const artifact = record(message.artifact);
  if (artifact) return artifact;
  if (typeof message.content !== "string" || message.content.length > 32_000)
    return null;
  try {
    return record(JSON.parse(message.content));
  } catch {
    return null;
  }
}

/** The committed artifact a tool message proves under its tool's contract. */
export function readCommittedToolMessage(
  message: BaseMessage,
): TerminalToolResult | null {
  if (!ToolMessage.isInstance(message) || message.status === "error")
    return null;
  const definition = getAgentToolDefinition(message.name ?? "");
  return definition?.terminalResult
    ? readTerminalToolResult(
        definition.terminalResult,
        readToolMessageResult(message),
      )
    : null;
}

/**
 * Derived from the scope's own messages, so checkpoints, resumes and child
 * graphs need no extra state. A receipt for an already-seen version (an
 * idempotent republish) does not restart the count; a new revision does.
 */
export function readCommittedDelivery(
  messages: readonly BaseMessage[],
): CommittedDelivery | null {
  const seen = new Set<string>();
  let latest: { index: number; result: TerminalToolResult } | null = null;
  for (const [index, message] of messages.entries()) {
    const result = readCommittedToolMessage(message);
    if (!result) continue;
    const version = JSON.stringify([
      result.artifactId,
      result.artifactVersionId,
    ]);
    if (seen.has(version)) continue;
    seen.add(version);
    latest = { index, result };
  }
  if (!latest) return null;
  const { index, result } = latest;
  return {
    result,
    toolDecisionsSince: messages
      .slice(index + 1)
      .filter(
        (message) =>
          AIMessage.isInstance(message) &&
          Boolean(
            message.tool_calls?.length || message.invalid_tool_calls?.length,
          ),
      ).length,
  };
}

export function isCommittedDeliveryExhausted(
  delivery: CommittedDelivery | null,
): boolean {
  return Boolean(
    delivery &&
    delivery.toolDecisionsSince >= COMMITTED_DELIVERY_TOOL_DECISION_LIMIT,
  );
}

export function committedDeliveryPrompt(delivery: CommittedDelivery): string {
  return `${COMMITTED_DELIVERY_PROMPT}${Math.max(
    0,
    COMMITTED_DELIVERY_TOOL_DECISION_LIMIT - delivery.toolDecisionsSince,
  )}`;
}
