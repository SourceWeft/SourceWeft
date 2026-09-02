import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import type { CapabilityManifest } from "@sourceweft/capability-contracts";
import { getAgentToolDefinition } from "@sourceweft/agent-tool-registry";
import { listCapabilityRecords } from "../../turn/capability-command-workflows";
import { ContentError } from "../../../content/errors";
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
 * Factories still receive the complete candidate set, but the host validates
 * their returned tools against the turn's selected, permitted ownership set.
 * Missing, unexpected, or duplicate bindings fail turn preparation.
 */
export function resolveCapabilityRecordToolIds(
  contributions: CapabilityManifest["contributes"],
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

function bindingFailure(
  code: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new ContentError(500, code, message, {
    details,
    recoverable: false,
  });
}

/**
 * Resolve the single capability entry module that owns each custom agent tool.
 * Top-level tool contributions are authoritative. A skill may own a tool only
 * when no top-level tool package declares it (for example
 * `review_deck_visuals`). Ambiguous ownership is a deployment error.
 */
export function resolveCapabilityToolOwners(
  records: readonly DiscoveredCapabilityRecord[],
): Map<string, string> {
  const owners = new Map<string, string>();
  const skillOnlyCandidates = new Map<string, Set<string>>();

  for (const record of records) {
    const contributions = record.manifest.contributes;
    for (const tool of contributions.tools) {
      const definition = getAgentToolDefinition(tool.id);
      if (!definition || definition.name !== tool.id) {
        bindingFailure(
          "CAPABILITY_TOOL_CONTRACT_INVALID",
          `Capability '${record.manifest.id}' declares unknown tool '${tool.id}'`,
          { capabilityId: record.manifest.id, toolId: tool.id },
        );
      }
      const existing = owners.get(tool.id);
      if (existing && existing !== record.manifest.id) {
        bindingFailure(
          "CAPABILITY_TOOL_OWNER_AMBIGUOUS",
          `Tool '${tool.id}' has more than one top-level capability owner`,
          { toolId: tool.id, owners: [existing, record.manifest.id] },
        );
      }
      owners.set(tool.id, record.manifest.id);
    }
  }

  for (const record of records) {
    const contributions = record.manifest.contributes;
    for (const toolId of contributions.skills.flatMap(
      (skill) => skill.runtime?.tools ?? [],
    )) {
      const definition = getAgentToolDefinition(toolId);
      if (!definition || definition.name !== toolId) {
        bindingFailure(
          "CAPABILITY_TOOL_CONTRACT_INVALID",
          `Capability '${record.manifest.id}' declares unknown skill runtime tool '${toolId}'`,
          { capabilityId: record.manifest.id, toolId },
        );
      }
      if (!owners.has(toolId)) {
        const candidates = skillOnlyCandidates.get(toolId) ?? new Set<string>();
        candidates.add(record.manifest.id);
        skillOnlyCandidates.set(toolId, candidates);
      }
    }
  }

  for (const [toolId, candidates] of skillOnlyCandidates) {
    if (candidates.size !== 1) {
      bindingFailure(
        "CAPABILITY_TOOL_OWNER_AMBIGUOUS",
        `Skill runtime tool '${toolId}' does not have exactly one implementation owner`,
        { toolId, owners: [...candidates].sort() },
      );
    }
    owners.set(toolId, [...candidates][0]!);
  }

  return owners;
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
  const toolOwners = resolveCapabilityToolOwners(records);
  const services = createCapabilityAgentToolHostServices(input, {
    webProvider: await createDefaultWebProvider(),
  });
  const context = createCapabilityAgentToolTurnContext(input);
  const tools: AgentTurnTool[] = [];
  const artifactTools: AgentTurnTool[] = [];
  const retrievalTools: AgentTurnTool[] = [];
  const webTools: AgentTurnTool[] = [];
  const promptProviders: ArtifactToolRuntimePromptProvider[] = [];
  const globallyBoundToolNames = new Set<string>();

  for (const record of records) {
    const toolIds = resolveCapabilityRecordToolIds(
      record.manifest.contributes,
      context.shouldBindAgentTool,
    );
    if (toolIds.length === 0) {
      continue;
    }
    const module = await loadCapabilityAgentToolModule(record);
    const factory = module?.createCapabilityAgentTools;
    const requiredToolIds = toolIds.filter((toolId) => {
      if (toolOwners.get(toolId) !== record.manifest.id) {
        return false;
      }
      const definition = getAgentToolDefinition(toolId);
      // Sandbox tools are produced by the selected sandbox runtime, not by the
      // generic capability factory host.
      if (definition?.domain === "sandbox") {
        return false;
      }
      return (
        context.shouldBindAgentTool(toolId) && !context.isToolDenied(toolId)
      );
    });
    if (!factory) {
      if (requiredToolIds.length > 0) {
        bindingFailure(
          "CAPABILITY_TOOL_FACTORY_MISSING",
          `Capability '${record.manifest.id}' has required tools but no createCapabilityAgentTools factory`,
          { capabilityId: record.manifest.id, toolIds: requiredToolIds },
        );
      }
      continue;
    }

    const result = await factory({
      manifest: record.manifest,
      toolIds,
      context,
      services,
    });
    const normalized = normalizeFactoryResult(result);
    const boundNames = normalized.tools.map((entry) => entry.tool.name);
    const duplicateNames = boundNames.filter(
      (name, index) => boundNames.indexOf(name) !== index,
    );
    if (duplicateNames.length > 0) {
      bindingFailure(
        "CAPABILITY_TOOL_BINDING_DUPLICATE",
        `Capability '${record.manifest.id}' returned duplicate tool bindings`,
        {
          capabilityId: record.manifest.id,
          toolIds: [...new Set(duplicateNames)].sort(),
        },
      );
    }
    const unexpectedToolIds = boundNames.filter(
      (toolId) =>
        !requiredToolIds.includes(toolId) ||
        toolOwners.get(toolId) !== record.manifest.id,
    );
    if (unexpectedToolIds.length > 0) {
      bindingFailure(
        "CAPABILITY_TOOL_BINDING_UNEXPECTED",
        `Capability '${record.manifest.id}' returned tools not selected for this turn`,
        {
          capabilityId: record.manifest.id,
          toolIds: [...new Set(unexpectedToolIds)].sort(),
        },
      );
    }
    const missingToolIds = requiredToolIds.filter(
      (toolId) => !boundNames.includes(toolId),
    );
    if (missingToolIds.length > 0) {
      bindingFailure(
        "CAPABILITY_TOOL_BINDING_MISSING",
        `Capability '${record.manifest.id}' did not bind every required tool`,
        { capabilityId: record.manifest.id, toolIds: missingToolIds },
      );
    }
    for (const toolName of boundNames) {
      if (globallyBoundToolNames.has(toolName)) {
        bindingFailure(
          "CAPABILITY_TOOL_BINDING_DUPLICATE",
          `Tool '${toolName}' was bound by more than one capability`,
          { capabilityId: record.manifest.id, toolId: toolName },
        );
      }
      globallyBoundToolNames.add(toolName);
    }
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
