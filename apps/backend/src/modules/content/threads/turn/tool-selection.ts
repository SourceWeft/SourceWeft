import { ContentError } from "../../errors";
import { AGENT_TOOL_NAMES } from "../../agent/tool-names";
import {
  isAgentToolEnabledByDefault,
  isGeneratedImageArtifactToolName,
  isNotionToolName,
  isSkillActivatedAgentTool,
  isVideoPresentationArtifactToolName,
  isWebSearchToolName,
} from "../../agent/tool-registry";
import type { EnabledSkillDescriptor } from "../../skills/types";
import {
  normalizeArtifactToolSelection,
  normalizeGenerateImageToolSelection,
  type GenerateImageToolSelection,
  type GeneratePptxToolSelection,
  type GenerateVideoPresentationToolSelection,
} from "../../artifacts/types";
import type { ConnectorToolSelection, ThreadToolsSelection } from "./types";

export type McpToolSelection = {
  enabled?: boolean;
  installIds?: string[];
  toolIds?: string[];
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function skillActivatesTool(
  skill: EnabledSkillDescriptor,
  predicate: (toolName: string) => boolean,
) {
  return (
    skill.tools?.some(
      (toolName) => isSkillActivatedAgentTool(toolName) && predicate(toolName),
    ) === true
  );
}

export function resolveWebSearchEnabled(input: {
  tools?: ThreadToolsSelection;
  enabledSkills: EnabledSkillDescriptor[];
}) {
  const explicitEnabled =
    input.tools?.[AGENT_TOOL_NAMES.webSearch]?.enabled ??
    input.tools?.webSearchEnabled;
  if (typeof explicitEnabled === "boolean") {
    return explicitEnabled;
  }

  return (
    isAgentToolEnabledByDefault(AGENT_TOOL_NAMES.webSearch) ||
    input.enabledSkills.some((skill) =>
      skillActivatesTool(skill, isWebSearchToolName),
    )
  );
}

export function resolveGenerateImageToolSelection(
  tools?: ThreadToolsSelection,
): GenerateImageToolSelection | undefined {
  const selection = normalizeGenerateImageToolSelection(
    tools?.[AGENT_TOOL_NAMES.generateImage],
  );
  const legacySelection = normalizeArtifactToolSelection(tools?.artifact);
  if (!legacySelection) {
    return selection;
  }

  return {
    ...(selection ?? {}),
    ...(legacySelection.modelAlias && !selection?.modelAlias
      ? { modelAlias: legacySelection.modelAlias }
      : {}),
    ...(selection?.execution ? { execution: selection.execution } : {}),
    ...(legacySelection.image && !selection?.config
      ? { config: legacySelection.image }
      : {}),
  };
}

export function resolveGeneratePptxToolSelection(
  tools?: ThreadToolsSelection,
): GeneratePptxToolSelection | undefined {
  const record = toRecord(tools?.[AGENT_TOOL_NAMES.generatePptx]);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const generationMode = ["visual_html", "editable_native"].includes(
    String(record.generationMode),
  )
    ? (record.generationMode as GeneratePptxToolSelection["generationMode"])
    : undefined;
  const design = normalizeDeckDesignSelection<GeneratePptxToolSelection>(
    record,
  );

  const outputRecord = toRecord(record.output);
  const output: NonNullable<GeneratePptxToolSelection["output"]> = {};
  if (outputRecord) {
    if (typeof outputRecord.includeSourceJson === "boolean") {
      output.includeSourceJson = outputRecord.includeSourceJson;
    }
  }

  const renderingRecord = toRecord(record.rendering);
  const rendering: NonNullable<GeneratePptxToolSelection["rendering"]> = {};
  if (
    renderingRecord &&
    typeof renderingRecord.preferHtmlTables === "boolean"
  ) {
    rendering.preferHtmlTables = renderingRecord.preferHtmlTables;
  }

  const selection: GeneratePptxToolSelection = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(generationMode ? { generationMode } : {}),
    ...(Object.keys(design).length > 0 ? { design } : {}),
    ...(Object.keys(output).length > 0 ? { output } : {}),
    ...(Object.keys(rendering).length > 0 ? { rendering } : {}),
  };
  return Object.keys(selection).length > 0 ? selection : undefined;
}

function normalizeDeckDesignSelection<
  T extends {
    design?: {
      aspectRatio?: "16:9" | "16:10" | "4:3";
      language?: "zh" | "en" | "auto";
      stylePreset?:
        | "executive"
        | "technical"
        | "editorial"
        | "data-heavy"
        | "custom";
      customBrief?: string;
      visualSystem?: {
        backgroundTreatment?: "auto" | "plain" | "grid" | "paper" | "image" | "gradient" | "diagram";
        chrome?: "minimal" | "magazine" | "lecture" | "report";
        compositionStyle?: "auto" | "axis" | "poster" | "split" | "notebook" | "schematic" | "report";
        coverTreatment?: string;
        density?: "airy" | "balanced" | "dense";
        geometry?: "sharp" | "soft" | "editorial" | "technical";
        illustration?: "none" | "icons" | "diagrams" | "image-led" | "handdrawn";
        palette?: string[];
        typography?: string[];
        layoutPrinciples?: string[];
        motifs?: string[];
        layoutPolicy?: {
          strict?: boolean;
          diversity?: "normal" | "high";
        };
        styleFamily?:
          | "auto"
          | "swiss"
          | "magazine"
          | "education"
          | "blueprint"
          | "data-report"
          | "editorial";
        imageDirection?: string;
        motion?: string;
      };
    };
  },
>(record: Record<string, unknown>) {
  const designRecord = toRecord(record.design);
  const design: NonNullable<T["design"]> = {};
  if (
    designRecord &&
    ["16:9", "16:10", "4:3"].includes(String(designRecord.aspectRatio))
  ) {
    design.aspectRatio = designRecord.aspectRatio as NonNullable<
      T["design"]
    >["aspectRatio"];
  }
  if (
    designRecord &&
    ["zh", "en", "auto"].includes(String(designRecord.language))
  ) {
    design.language = designRecord.language as NonNullable<
      T["design"]
    >["language"];
  }
  if (
    designRecord &&
    ["executive", "technical", "editorial", "data-heavy", "custom"].includes(
      String(designRecord.stylePreset),
    )
  ) {
    design.stylePreset = designRecord.stylePreset as NonNullable<
      T["design"]
    >["stylePreset"];
  }
  if (
    designRecord &&
    typeof designRecord.customBrief === "string" &&
    designRecord.customBrief.trim().length > 0
  ) {
    design.customBrief = designRecord.customBrief.trim().slice(0, 2000) as NonNullable<
      T["design"]
    >["customBrief"];
  }
  const visualSystemRecord = toRecord(designRecord?.visualSystem);
  if (visualSystemRecord) {
    const visualSystem: NonNullable<
      NonNullable<T["design"]>["visualSystem"]
    > = {};
    const compactStringList = (
      value: unknown,
      maxItems: number,
      maxLength: number,
    ) =>
      Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, maxItems)
            .map((item) => item.slice(0, maxLength))
        : [];
    const palette = compactStringList(visualSystemRecord.palette, 12, 80);
    if (palette.length > 0) {
      visualSystem.palette = palette as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["palette"];
    }
    const typography = compactStringList(visualSystemRecord.typography, 8, 120);
    if (typography.length > 0) {
      visualSystem.typography = typography as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["typography"];
    }
    const layoutPrinciples = compactStringList(
      visualSystemRecord.layoutPrinciples,
      12,
      200,
    );
    if (layoutPrinciples.length > 0) {
      visualSystem.layoutPrinciples = layoutPrinciples as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["layoutPrinciples"];
    }
    const motifs = compactStringList(visualSystemRecord.motifs, 8, 80);
    if (motifs.length > 0) {
      visualSystem.motifs = motifs as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["motifs"];
    }
    if (
      typeof visualSystemRecord.coverTreatment === "string" &&
      visualSystemRecord.coverTreatment.trim().length > 0
    ) {
      visualSystem.coverTreatment = visualSystemRecord.coverTreatment
        .trim()
        .slice(0, 80) as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["coverTreatment"];
    }
    if (
      ["auto", "axis", "poster", "split", "notebook", "schematic", "report"].includes(
        String(visualSystemRecord.compositionStyle),
      )
    ) {
      visualSystem.compositionStyle = visualSystemRecord.compositionStyle as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["compositionStyle"];
    }
    if (
      [
        "auto",
        "plain",
        "grid",
        "paper",
        "image",
        "gradient",
        "diagram",
      ].includes(String(visualSystemRecord.backgroundTreatment))
    ) {
      visualSystem.backgroundTreatment =
        visualSystemRecord.backgroundTreatment as NonNullable<
          NonNullable<T["design"]>["visualSystem"]
        >["backgroundTreatment"];
    }
    if (
      [
        "auto",
        "swiss",
        "magazine",
        "education",
        "blueprint",
        "data-report",
        "editorial",
      ].includes(String(visualSystemRecord.styleFamily))
    ) {
      visualSystem.styleFamily = visualSystemRecord.styleFamily as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["styleFamily"];
    }
    if (["airy", "balanced", "dense"].includes(String(visualSystemRecord.density))) {
      visualSystem.density = visualSystemRecord.density as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["density"];
    }
    if (
      ["sharp", "soft", "editorial", "technical"].includes(
        String(visualSystemRecord.geometry),
      )
    ) {
      visualSystem.geometry = visualSystemRecord.geometry as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["geometry"];
    }
    if (
      ["minimal", "magazine", "lecture", "report"].includes(
        String(visualSystemRecord.chrome),
      )
    ) {
      visualSystem.chrome = visualSystemRecord.chrome as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["chrome"];
    }
    if (
      ["none", "icons", "diagrams", "image-led", "handdrawn"].includes(
        String(visualSystemRecord.illustration),
      )
    ) {
      visualSystem.illustration = visualSystemRecord.illustration as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["illustration"];
    }
    const layoutPolicyRecord = toRecord(visualSystemRecord.layoutPolicy);
    if (layoutPolicyRecord) {
      const layoutPolicy: NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["layoutPolicy"] = {};
      if (typeof layoutPolicyRecord.strict === "boolean") {
        layoutPolicy.strict = layoutPolicyRecord.strict;
      }
      if (
        ["normal", "high"].includes(String(layoutPolicyRecord.diversity))
      ) {
        layoutPolicy.diversity = layoutPolicyRecord.diversity as NonNullable<
          NonNullable<
            NonNullable<T["design"]>["visualSystem"]
          >["layoutPolicy"]
        >["diversity"];
      }
      if (Object.keys(layoutPolicy).length > 0) {
        visualSystem.layoutPolicy = layoutPolicy;
      }
    }
    if (
      typeof visualSystemRecord.imageDirection === "string" &&
      visualSystemRecord.imageDirection.trim().length > 0
    ) {
      visualSystem.imageDirection = visualSystemRecord.imageDirection
        .trim()
        .slice(0, 1000) as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["imageDirection"];
    }
    if (
      typeof visualSystemRecord.motion === "string" &&
      visualSystemRecord.motion.trim().length > 0
    ) {
      visualSystem.motion = visualSystemRecord.motion.trim().slice(0, 1000) as NonNullable<
        NonNullable<T["design"]>["visualSystem"]
      >["motion"];
    }
    if (Object.keys(visualSystem).length > 0) {
      design.visualSystem = visualSystem;
    }
  }
  return design;
}

export function resolveGenerateVideoPresentationToolSelection(
  tools?: ThreadToolsSelection,
): GenerateVideoPresentationToolSelection | undefined {
  const record = toRecord(tools?.[AGENT_TOOL_NAMES.generateVideoPresentation]);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;

  const narrationRecord = toRecord(record.narration);
  const narration: NonNullable<
    GenerateVideoPresentationToolSelection["narration"]
  > = {};
  if (narrationRecord && typeof narrationRecord.enabled === "boolean") {
    narration.enabled = narrationRecord.enabled;
  }

  const selection: GenerateVideoPresentationToolSelection = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(Object.keys(narration).length > 0 ? { narration } : {}),
  };
  return Object.keys(selection).length > 0 ? selection : undefined;
}

export function buildThreadToolsMetadata(input: {
  invokedSkillIds?: string[];
  skillIds: string[];
  webSearchEnabled: boolean;
  generateImageTool?: GenerateImageToolSelection;
  generatePptxTool?: GeneratePptxToolSelection;
  generateVideoPresentationTool?: GenerateVideoPresentationToolSelection;
  notionTools?: Record<string, ConnectorToolSelection>;
  mcpTools?: McpToolSelection;
}) {
  const withExplicitEnabled = <T extends { enabled?: boolean }>(selection: T) => ({
    ...selection,
    enabled: selection.enabled ?? true,
  });

  return {
    skillIds: input.skillIds,
    ...(input.invokedSkillIds?.length
      ? { invokedSkillIds: input.invokedSkillIds }
      : {}),
    [AGENT_TOOL_NAMES.webSearch]: {
      enabled: input.webSearchEnabled,
    },
    ...(input.generateImageTool
      ? {
          [AGENT_TOOL_NAMES.generateImage]: withExplicitEnabled(
            input.generateImageTool,
          ),
        }
      : {}),
    ...(input.generatePptxTool
      ? {
          [AGENT_TOOL_NAMES.generatePptx]: withExplicitEnabled(
            input.generatePptxTool,
          ),
        }
      : {}),
    ...(input.generateVideoPresentationTool
      ? {
          [AGENT_TOOL_NAMES.generateVideoPresentation]:
            withExplicitEnabled(input.generateVideoPresentationTool),
        }
      : {}),
    ...(input.notionTools ?? {}),
    ...(input.mcpTools ? { mcp: withExplicitEnabled(input.mcpTools) } : {}),
  };
}

export function assertSelectedSkillsAllowedByTools(input: {
  enabledSkills: EnabledSkillDescriptor[];
  generateImageTool?: GenerateImageToolSelection;
  generatePptxTool?: GeneratePptxToolSelection;
  generateVideoPresentationTool?: GenerateVideoPresentationToolSelection;
}) {
  if (input.generateImageTool?.enabled === false) {
    const blockedSkill = input.enabledSkills.find((skill) =>
      skillActivatesTool(skill, isGeneratedImageArtifactToolName),
    );
    if (blockedSkill) {
      throw new ContentError(
        403,
        "SKILL_TOOL_DISABLED",
        `Selected skill '${blockedSkill.name}' requires ${AGENT_TOOL_NAMES.generateImage}, which is disabled for this turn`,
      );
    }
  }

  if (input.generatePptxTool?.enabled === false) {
    const blockedSkill = input.enabledSkills.find((skill) =>
      skillActivatesTool(
        skill,
        (toolName) => toolName === AGENT_TOOL_NAMES.generatePptx,
      ),
    );
    if (blockedSkill) {
      throw new ContentError(
        403,
        "SKILL_TOOL_DISABLED",
        `Selected skill '${blockedSkill.name}' requires ${AGENT_TOOL_NAMES.generatePptx}, which is disabled for this turn`,
      );
    }
  }

  if (input.generateVideoPresentationTool?.enabled === false) {
    const blockedSkill = input.enabledSkills.find((skill) =>
      skillActivatesTool(skill, isVideoPresentationArtifactToolName),
    );
    if (blockedSkill) {
      throw new ContentError(
        403,
        "SKILL_TOOL_DISABLED",
        `Selected skill '${blockedSkill.name}' requires ${AGENT_TOOL_NAMES.generateVideoPresentation}, which is disabled for this turn`,
      );
    }
  }
}

export function resolveWebSearchEnabledFromToolsMetadata(value: unknown) {
  const tools = toRecord(value);
  const webSearch = toRecord(tools?.[AGENT_TOOL_NAMES.webSearch]);
  if (typeof webSearch?.enabled === "boolean") {
    return webSearch.enabled;
  }
  return tools?.webSearchEnabled === true;
}

export function resolveGenerateImageToolFromToolsMetadata(value: unknown) {
  const tools = toRecord(value);
  const selection = normalizeGenerateImageToolSelection(
    tools?.[AGENT_TOOL_NAMES.generateImage],
  );
  const legacySelection = normalizeArtifactToolSelection(tools?.artifact);
  if (!legacySelection) {
    return selection;
  }

  return {
    ...(selection ?? {}),
    ...(legacySelection.modelAlias && !selection?.modelAlias
      ? { modelAlias: legacySelection.modelAlias }
      : {}),
    ...(selection?.execution ? { execution: selection.execution } : {}),
    ...(legacySelection.image && !selection?.config
      ? { config: legacySelection.image }
      : {}),
  };
}

export function resolveGeneratePptxToolFromToolsMetadata(value: unknown) {
  const tools = toRecord(value);
  return resolveGeneratePptxToolSelection(
    tools as ThreadToolsSelection | undefined,
  );
}

export function resolveGenerateVideoPresentationToolFromToolsMetadata(
  value: unknown,
) {
  const tools = toRecord(value);
  return resolveGenerateVideoPresentationToolSelection(
    tools as ThreadToolsSelection | undefined,
  );
}

function normalizeConnectorToolSelection(
  value: unknown,
): ConnectorToolSelection | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const connectorId =
    typeof record.connectorId === "string" && record.connectorId.trim()
      ? record.connectorId.trim()
      : undefined;
  if (enabled === undefined && connectorId === undefined) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(connectorId ? { connectorId } : {}),
  };
}

export function resolveNotionToolSelections(
  tools?: ThreadToolsSelection,
): Record<string, ConnectorToolSelection> {
  const selections: Record<string, ConnectorToolSelection> = {};
  if (!tools) {
    return selections;
  }
  const rawTools = tools as Record<string, unknown>;
  for (const toolName of Object.values(AGENT_TOOL_NAMES)) {
    if (!isNotionToolName(toolName)) {
      continue;
    }
    const selection = normalizeConnectorToolSelection(rawTools[toolName]);
    if (selection) {
      selections[toolName] = selection;
    }
  }
  return selections;
}

export function resolveNotionToolSelectionsFromToolsMetadata(
  value: unknown,
): Record<string, ConnectorToolSelection> {
  const tools = toRecord(value);
  const selections: Record<string, ConnectorToolSelection> = {};
  if (!tools) {
    return selections;
  }
  for (const toolName of Object.values(AGENT_TOOL_NAMES)) {
    if (!isNotionToolName(toolName)) {
      continue;
    }
    const selection = normalizeConnectorToolSelection(tools[toolName]);
    if (selection) {
      selections[toolName] = selection;
    }
  }
  return selections;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

export function resolveMcpToolSelection(
  tools?: ThreadToolsSelection,
): McpToolSelection | undefined {
  const record = toRecord(tools?.mcp);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const installIds = normalizeStringArray(record.installIds);
  const toolIds = normalizeStringArray(record.toolIds);
  if (
    enabled === undefined &&
    installIds.length === 0 &&
    toolIds.length === 0
  ) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(installIds.length > 0 ? { installIds } : {}),
    ...(toolIds.length > 0 ? { toolIds } : {}),
  };
}

export function resolveMcpToolSelectionFromToolsMetadata(
  value: unknown,
): McpToolSelection | undefined {
  const tools = toRecord(value);
  const record = toRecord(tools?.mcp);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const installIds = normalizeStringArray(record.installIds);
  const toolIds = normalizeStringArray(record.toolIds);
  if (
    enabled === undefined &&
    installIds.length === 0 &&
    toolIds.length === 0
  ) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(installIds.length > 0 ? { installIds } : {}),
    ...(toolIds.length > 0 ? { toolIds } : {}),
  };
}

export function enableNotionToolSelection(
  tools: StreamThreadToolsSelectionLike,
  toolName: string,
) {
  if (!isNotionToolName(toolName)) {
    return tools;
  }
  const rawTools = (tools ?? {}) as Record<string, unknown>;
  return {
    ...(tools ?? {}),
    [toolName]: {
      ...normalizeConnectorToolSelection(rawTools[toolName]),
      enabled: true,
    },
  };
}

type StreamThreadToolsSelectionLike = ThreadToolsSelection | undefined;

export const testExports = {
  assertSelectedSkillsAllowedByTools,
  resolveGeneratePptxToolSelection,
  resolveGenerateVideoPresentationToolSelection,
  resolveMcpToolSelectionFromToolsMetadata,
};
