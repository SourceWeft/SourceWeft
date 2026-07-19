import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import { notionAgentToolDefs } from "@sourceweft/builtin-connector-notion";
import { generateVideoPresentationAgentToolDefs } from "@sourceweft/builtin-tool-video-presentation/agent-tool-defs";

let registered = false;

/**
 * Keep the web registry in sync with backend-visible builtin tools that the
 * chat UI needs for capability checks (progress, composer locking, labels,
 * artifact rendering). Defs are imported from their owning packages rather than
 * re-declared here so the web registry cannot drift from the canonical source.
 */
export function registerBuiltinAgentTools() {
  if (registered) {
    return;
  }
  registerAgentTools([
    ...notionAgentToolDefs,
    ...generateVideoPresentationAgentToolDefs,
  ]);
  registered = true;
}
