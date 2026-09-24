import type { InterruptOnConfig } from "langchain";
import { sandboxToolInterruptDescriptions } from "../sandbox-tools";
import { EXECUTE_TOOL_NAME } from "@sourceweft/contracts/agent-tools";

/**
 * Sandbox tool approval gates `execute` only: it is the one sandbox tool that
 * runs code. Prepare copies the thread's own Workfiles into its sandbox and
 * collect copies sandbox text outputs back into the thread; neither runs a
 * command, so gating them added confirmations without adding protection.
 */
export function createSandboxInterruptConfigs(): Record<string, InterruptOnConfig> {
  return {
    [EXECUTE_TOOL_NAME]: {
      allowedDecisions: ["approve", "edit", "reject"],
      description: sandboxToolInterruptDescriptions[EXECUTE_TOOL_NAME],
    },
  };
}
