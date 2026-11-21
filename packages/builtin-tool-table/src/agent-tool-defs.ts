import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

/**
 * The thin chat entry to data tables: it queues the same generation the source
 * hub's dialog does and returns the pending artifact. It fills no cell itself.
 *
 * Off by default and bound by the `/table` command (or a skill that declares
 * it). Permission and risk mirror `generate_image`, the other tool that spends
 * the actor's credits on an artifact: the user asked for it by name, so it runs
 * without a confirmation, and the job charges that user.
 */
export const generateTableAgentTool = defineAgentTool({
  id: "generateTable",
  name: "generate_table",
  domain: "artifact",
  capabilities: ["artifact"],
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    aliases: ["table"],
    description: "Compare the selected sources in a data table",
    displayName: "Data Table",
    supportsCommand: true,
  },
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const GENERATE_TABLE_TOOL_NAME = generateTableAgentTool.name;

export const tableAgentToolDefs = [generateTableAgentTool] as const;
