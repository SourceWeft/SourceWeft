/**
 * The sandbox operation timeline: which tools carry one, and how it is appended
 * to their output for the client without changing what the model saw.
 */
import { toObjectRecord } from "../../../../../shared/records";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";

export function isSandboxOperationTimelineTool(toolName: string) {
  return (
    toolName === AGENT_TOOL_NAMES.prepareSandboxWorkspace ||
    toolName === AGENT_TOOL_NAMES.execute ||
    toolName === AGENT_TOOL_NAMES.collectSandboxOutputs
  );
}

export function appendSandboxOperationTimeline(
  toolName: string,
  output: unknown,
  operations: readonly unknown[],
) {
  if (!isSandboxOperationTimelineTool(toolName) || operations.length === 0) {
    return output;
  }

  const outputRecord = toObjectRecord(output);
  return outputRecord
    ? { ...outputRecord, operations: [...operations] }
    : { content: output, operations: [...operations] };
}
