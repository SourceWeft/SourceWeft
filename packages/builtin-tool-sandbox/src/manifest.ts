import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import {
  PREPARE_SANDBOX_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";
import { sandboxToolDescriptions } from "./sandbox-tools";

export const builtinSandboxCapabilityManifest: CapabilityManifestInput = {
  schemaVersion: 1,
  id: "sourceweft/sandbox",
  kind: "tool",
  name: "Sandbox",
  version: "0.1.0",
  entry: "./src/index.ts",
  tools: [
      {
        id: PREPARE_SANDBOX_TOOL_NAME,
        title: "Prepare Sandbox Workspace",
        description: sandboxToolDescriptions.prepareSandboxWorkspace,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "write",
        options: [],
      },
      {
        id: EXECUTE_TOOL_NAME,
        title: "Execute Sandbox Command",
        description: sandboxToolDescriptions.execute,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "destructive",
        options: [],
      },
      {
        id: COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
        title: "Collect Sandbox Outputs",
        description: sandboxToolDescriptions.collectSandboxOutputs,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "write",
        options: [],
      },
  ],
};
