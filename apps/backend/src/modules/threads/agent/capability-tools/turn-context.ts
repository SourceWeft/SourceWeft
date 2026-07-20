import {
  isToolDenied,
  resolveSourceUserMessageId,
  shouldBindAgentTool,
} from "../turn/tool-utils";
import type {
  CapabilityAgentToolsForTurnInput,
  CapabilityAgentToolTurnContext,
} from "./types";

/**
 * The turn, as every capability sees it.
 *
 * The return type is annotated rather than inferred on purpose: it is half of
 * the host↔capability contract, so a field that stops being produced here has
 * to be removed from the contract too, which is what makes the capabilities
 * that read it fail to compile.
 */
export function createCapabilityAgentToolTurnContext(
  input: CapabilityAgentToolsForTurnInput,
): CapabilityAgentToolTurnContext {
  const { prepared, traceContext } = input;
  return {
    // Handed over whole and unread: each capability takes its own entry out of
    // it. The host carried three image-shaped fields here once.
    turnState: prepared.turnState,
    isToolDenied: (toolName: string) => isToolDenied(prepared, toolName),
    parentSpanId: traceContext?.parentSpanId,
    runtimeTools: prepared.runtimeTools,
    shouldBindAgentTool: (toolName: string) =>
      shouldBindAgentTool({ prepared, toolName }),
    sourceUserMessageId: resolveSourceUserMessageId(prepared),
    teamId: prepared.workspace.organizationId,
    threadId: prepared.thread.id,
    traceId: traceContext?.traceId,
    userId: prepared.userId,
    userMessageId: prepared.userMessage.id,
    webAccessEnabled: prepared.webAccessEnabled,
    workspaceId: prepared.workspace.id,
  };
}
