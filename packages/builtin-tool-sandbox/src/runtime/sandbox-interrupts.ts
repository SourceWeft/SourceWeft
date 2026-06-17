import type { InterruptOnConfig } from "langchain";
import { sandboxToolInterruptDescriptions } from "../sandbox-tools";
import {
  PREPARE_SANDBOX_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";

export function createSandboxInterruptConfigs(): Record<string, InterruptOnConfig> {
  return {
    [PREPARE_SANDBOX_TOOL_NAME]: {
      allowedDecisions: ["approve", "reject"],
      description: sandboxToolInterruptDescriptions[PREPARE_SANDBOX_TOOL_NAME],
    },
    [EXECUTE_TOOL_NAME]: {
      allowedDecisions: ["approve", "edit", "reject"],
      description: sandboxToolInterruptDescriptions[EXECUTE_TOOL_NAME],
    },
    [COLLECT_SANDBOX_OUTPUTS_TOOL_NAME]: {
      allowedDecisions: ["approve", "reject"],
      description: sandboxToolInterruptDescriptions[COLLECT_SANDBOX_OUTPUTS_TOOL_NAME],
    },
  };
}
