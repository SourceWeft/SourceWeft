import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import { listCapabilityRecords } from "../../turn/capability-command-workflows";
import type { ArtifactToolRuntimePromptProvider } from "../prompts/tool-prompt-provider";
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
  const services = createCapabilityAgentToolHostServices(input);
  const context = createCapabilityAgentToolTurnContext(input);
  const tools: AgentTurnTool[] = [];
  const artifactTools: AgentTurnTool[] = [];
  const retrievalTools: AgentTurnTool[] = [];
  const webTools: AgentTurnTool[] = [];
  const promptProviders: ArtifactToolRuntimePromptProvider[] = [];

  for (const record of records) {
    const toolIds = getCapabilityContributions(record.manifest).tools.map(
      (tool) => tool.id,
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
