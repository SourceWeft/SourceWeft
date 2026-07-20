import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import { notionAgentToolDefs } from "@sourceweft/builtin-connector-notion";

/**
 * Runtime-registered tools only. Everything statically known lives in the
 * registry's own AGENT_TOOLS table and is already visible here; re-listing such
 * a tool would be a no-op that also names a capability inside the app. Connector
 * tools are the genuine exception — they are bound per workspace, so no static
 * table can carry them.
 *
 * Kept as a named function purely so app boot (app/providers.tsx) and the test
 * environment (vitest.setup.ts) register the same set; re-entry needs no guard
 * here because registerAgentTools already skips names it has seen.
 */
export function registerBuiltinAgentTools() {
  registerAgentTools(notionAgentToolDefs);
}
