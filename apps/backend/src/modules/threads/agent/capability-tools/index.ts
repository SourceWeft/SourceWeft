import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import { listCapabilityRecords } from "../../turn/capability-command-workflows";
import type { ArtifactToolRuntimePromptProvider } from "../prompts/tool-prompt-provider";
import { createDefaultWebProvider } from "../../../sources/web-provider";
import { createCapabilityAgentToolHostServices } from "./host-services";
import { loadCapabilityAgentToolModule } from "./module-loader";
import { normalizeFactoryResult } from "./normalize";
import { createCapabilityAgentToolTurnContext } from "./turn-context";
import type {
  AgentTurnTool,
  CapabilityAgentToolsForTurn,
  CapabilityAgentToolsForTurnInput,
} from "./types";

/**
 * The tool ids a capability record contributes to this turn.
 *
 * Two sources feed it. Top-level `contributes.tools` are the tools a `kind:"tool"`
 * package owns; they are always offered to the factory, which decides per turn
 * whether to bind them. Skill runtime tools are the tools a skill declares in its
 * `runtime.tools` — the only channel by which a skill can ship a tool of its own,
 * because the manifest schema forbids a skill-kind manifest from declaring
 * top-level `tools`. Those are gated by `shouldBindAgentTool`, so an off-by-default,
 * skill-activated tool (ppt-deck's `review_deck_visuals`) binds only on a turn that
 * invoked the declaring skill and is absent everywhere else.
 *
 * Ids a record's own factory does not implement are harmless: every factory
 * filters `toolIds` itself and ignores the rest, so the union never double-binds.
 */
export function resolveCapabilityRecordToolIds(
  contributions: ReturnType<typeof getCapabilityContributions>,
  shouldBindAgentTool: (toolId: string) => boolean,
): string[] {
  const skillRuntimeToolIds = contributions.skills
    .flatMap((skill) => skill.runtime?.tools ?? [])
    .filter((toolId) => shouldBindAgentTool(toolId));
  return Array.from(
    new Set([
      ...contributions.tools.map((tool) => tool.id),
      ...skillRuntimeToolIds,
    ]),
  );
}

/**
 * Binds every capability's agent tools for one turn.
 *
 * The host iterates capability records, loads each one's entry module and calls
 * its factory with the turn context and the shared services bag. It does not
 * know what any of them will return: which tools exist, what they are called,
 * what they produce and which categories they claim are all the capability's
 * own declarations.
 *
 * The four concerns behind this loop live in their own modules — module loading
 * and its cache, the turn context, the host services, and result normalization
 * — because they change for unrelated reasons and only the loop needs all four.
 */
export async function createCapabilityAgentToolsForTurn(
  input: CapabilityAgentToolsForTurnInput,
): Promise<CapabilityAgentToolsForTurn> {
  const records = await listCapabilityRecords();
  const services = createCapabilityAgentToolHostServices(input, {
    webProvider: await createDefaultWebProvider(),
  });
  const context = createCapabilityAgentToolTurnContext(input);
  const tools: AgentTurnTool[] = [];
  const artifactTools: AgentTurnTool[] = [];
  const retrievalTools: AgentTurnTool[] = [];
  const webTools: AgentTurnTool[] = [];
  const promptProviders: ArtifactToolRuntimePromptProvider[] = [];

  for (const record of records) {
    const toolIds = resolveCapabilityRecordToolIds(
      getCapabilityContributions(record.manifest),
      context.shouldBindAgentTool,
    );
    if (toolIds.length === 0) {
      continue;
    }
    const module = await loadCapabilityAgentToolModule(record);
    const factory = module?.createCapabilityAgentTools;
    if (!factory) {
      continue;
    }

    const result = await factory({
      manifest: record.manifest,
      toolIds,
      context,
      services,
    });
    const normalized = normalizeFactoryResult(result);
    for (const provider of normalized.promptProviders) {
      promptProviders.push(provider);
    }
    for (const entry of normalized.tools) {
      tools.push(entry.tool);
      if (entry.categories.includes("artifact")) {
        artifactTools.push(entry.tool);
      }
      if (entry.categories.includes("retrieval")) {
        retrievalTools.push(entry.tool);
      }
      if (entry.categories.includes("web")) {
        webTools.push(entry.tool);
      }
    }
  }

  return {
    artifactTools,
    promptProviders,
    retrievalTools,
    tools,
    webTools,
  };
}

export type {
  AgentTurnTool,
  CapabilityAgentToolCategory,
  CapabilityAgentToolEntry,
  CapabilityAgentToolFactoryInput,
  CapabilityAgentToolFactoryResult,
  CapabilityAgentToolHostServices,
  CapabilityAgentToolModule,
  CapabilityAgentToolTurnContext,
  CapabilityAgentToolsForTurn,
  CapabilityAgentToolsForTurnInput,
} from "./types";
