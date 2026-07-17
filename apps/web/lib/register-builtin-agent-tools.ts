import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import { notionAgentToolDefs } from "@sourceweft/builtin-connector-notion";

let registered = false;

export function registerBuiltinAgentTools() {
  if (registered) {
    return;
  }
  registerAgentTools([...notionAgentToolDefs]);
  registered = true;
}
