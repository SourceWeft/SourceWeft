import type { CommandSuccessCriteria, PreparedThreadTurn } from "../..";
import type { EnabledSkillDescriptor } from "../../../skills/types";
import type { VirtualFsSource } from "../database-vfs-store";
import { formatDateInTimeZone } from "../turn/output-normalizer";
import type {
  ArtifactToolRuntimePromptProvider,
  RuntimePromptContext,
} from "./tool-prompt-provider";

export type ToolRuntimePromptProvider = (context: {
  currentDate: string;
}) => string | string[];

function escapeRuntimeValue(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim() ?? "")
        .filter((value) => value.length > 0),
    ),
  );
}

function readableSourcePath(source: VirtualFsSource) {
  return source.filePath ?? source.readmePath ?? source.dirPath;
}

function formatRuntimeSourceReference(source: VirtualFsSource) {
  const mentionLabels = uniqueNonEmpty([source.title, source.fileName])
    .map((value) => `@${value}`)
    .join(", ");
  const originalFile = source.fileName?.trim();
  const parts = [
    `title="${escapeRuntimeValue(source.title)}"`,
    originalFile ? `original_file="${escapeRuntimeValue(originalFile)}"` : null,
    mentionLabels
      ? `mention_labels="${escapeRuntimeValue(mentionLabels)}"`
      : null,
    `kb_path="${escapeRuntimeValue(readableSourcePath(source))}"`,
    source.sourceType === "directory"
      ? `kb_directory="${escapeRuntimeValue(source.dirPath)}"`
      : null,
    `type="${escapeRuntimeValue(source.sourceType)}"`,
    `chunks="${source.chunkCount}"`,
  ].filter((part): part is string => part !== null);

  return `- ${parts.join(" ")}`;
}

function buildSelectedSourceManifest(input: {
  label?: string;
  sources: VirtualFsSource[];
  omittedCount: number;
}) {
  if (input.sources.length === 0) {
    return "";
  }

  const label = input.label ?? "visible";
  return [
    "<selected_source_manifest>",
    `These are the current turn's ${label} Source Library entries visible under /kb.`,
    "Resolve user @mentions, attachment labels, and filenames against title, original_file, and mention_labels below.",
    "Do not synthesize /workfiles/<filename> for @mentions or source filenames. /workfiles contains only thread Workfiles.",
    ...input.sources.map(formatRuntimeSourceReference),
    input.omittedCount > 0
      ? `- ${input.omittedCount} additional source entries omitted from this manifest; use ls('/kb') if you need to enumerate them.`
      : null,
    "</selected_source_manifest>",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildActiveSkillsRuntimePrompt(input: {
  enabledSkills: EnabledSkillDescriptor[];
  activeSkillIds: string[];
}) {
  if (input.activeSkillIds.length === 0) {
    return "";
  }
  const activeSkillIdSet = new Set(input.activeSkillIds);
  const activeSkills = (input.enabledSkills ?? []).filter((skill) =>
    activeSkillIdSet.has(skill.workspaceSkillId),
  );
  if (activeSkills.length === 0) {
    return "";
  }

  return [
    "<active_skills>",
    "These skills are active for this turn. This is a strong instruction, not a suggestion: read each skill_path with read_file before doing the workflow, then follow that SKILL.md unless it conflicts with higher-priority system rules.",
    ...activeSkills.flatMap((skill) => {
      const skillPath = `/skills/${skill.name}/SKILL.md`;
      const lines = [
        `- name="${escapeRuntimeValue(skill.name)}"`,
        `description="${escapeRuntimeValue(skill.description)}"`,
        `skill_path="${escapeRuntimeValue(skillPath)}"`,
        `read_required="true"`,
      ].join(" ");
      const runtimeConfig = readSkillRuntimeConfig(skill);
      if (!runtimeConfig) {
        return [lines];
      }
      return [
        lines,
        "runtime_config_policy=\"User-selected options for this skill. Treat these values as generation constraints and follow them unless they conflict with higher-priority instructions or the user's latest explicit request.\"",
        `<skill_runtime_config name="${escapeRuntimeValue(skill.name)}">`,
        ...Object.entries(runtimeConfig).map(
          ([key, value]) =>
            `${key}: ${escapeRuntimeValue(formatRuntimeConfigValue(value))}`,
        ),
        "</skill_runtime_config>",
      ];
    }),
    "</active_skills>",
  ].join("\n");
}

function readSkillRuntimeConfig(skill: EnabledSkillDescriptor) {
  const config =
    skill.defaultConfig?.config &&
    typeof skill.defaultConfig.config === "object" &&
    !Array.isArray(skill.defaultConfig.config)
      ? (skill.defaultConfig.config as Record<string, unknown>)
      : null;
  return config && Object.keys(config).length > 0 ? config : null;
}

function formatRuntimeConfigValue(value: unknown) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildCommandSuccessInstruction(criteria: CommandSuccessCriteria) {
  switch (criteria.kind) {
    case "none":
      return "";
    case "artifact":
      return `Command success requires creating a ${criteria.artifactType} artifact by completing ${criteria.toolName} and returning a valid artifact URL. Call the publishing tool only after the artifact source is actually ready.`;
    case "tool_call":
      return `Command success requires calling ${criteria.toolName} successfully.`;
  }
}

export function buildAgentRuntimeContext(input: {
  availableWebTools?: string[];
  availableArtifactTools?: string[];
  availableMcpTools?: string[];
  artifactToolRuntimePromptProviders?: ArtifactToolRuntimePromptProvider[];
  turnState?: PreparedThreadTurn["turnState"];
  runtimeTools?: PreparedThreadTurn["runtimeTools"];
  commandSuccessCriteria?: PreparedThreadTurn["commandSuccessCriteria"];
  enabledSkills?: EnabledSkillDescriptor[];
  invokedSkillIds?: string[];
  toolRuntimePromptProviders?: ToolRuntimePromptProvider[];
  timezone: string;
  selectedSources?: VirtualFsSource[];
  selectedSourcesOmitted?: number;
}) {
  const timeZone = input.timezone;
  const currentDate = formatDateInTimeZone(new Date(), timeZone);
  const lines = [
    `Current date: ${currentDate}.`,
    `Current timezone: ${timeZone}.`,
  ];

  const sourceManifest = buildSelectedSourceManifest({
    sources: input.selectedSources ?? [],
    omittedCount: input.selectedSourcesOmitted ?? 0,
  });
  if (sourceManifest) {
    lines.push(sourceManifest);
  }

  const invokedSkillsPrompt = buildActiveSkillsRuntimePrompt({
    enabledSkills: input.enabledSkills ?? [],
    activeSkillIds: input.invokedSkillIds ?? [],
  });
  if (invokedSkillsPrompt) {
    lines.push(invokedSkillsPrompt);
  }

  const commandSuccessInstruction = buildCommandSuccessInstruction(
    input.commandSuccessCriteria ?? { kind: "none" },
  );
  if (commandSuccessInstruction) {
    lines.push(
      "<sourceweft_command_success>",
      commandSuccessInstruction,
      "</sourceweft_command_success>",
    );
  }

  const availableWebTools = input.availableWebTools ?? [];
  if (availableWebTools.length > 0) {
    lines.push(
      `Available public web tools this turn: ${availableWebTools.join(", ")}.`,
      "For workspace-specific or selected-source questions, use selected source tools first. Use web tools only when the user explicitly asks for internet information, asks about current public facts, or selected sources do not contain enough evidence.",
      `When a date qualifier is useful, use the current date/year from this runtime context: ${currentDate}.`,
    );
  }

  const availableArtifactTools = input.availableArtifactTools ?? [];
  const providerContext: RuntimePromptContext = {
    availableArtifactTools,
    availableWebTools,
    availableMcpTools: input.availableMcpTools ?? [],
    currentDate,
    turnState: input.turnState,
    runtimeTools: input.runtimeTools,
  };
  const artifactToolLines = (
    input.artifactToolRuntimePromptProviders ?? []
  ).flatMap((provider) => provider.buildLines(providerContext));
  if (availableArtifactTools.length > 0 || artifactToolLines.length > 0) {
    lines.push(
      `Available artifact tools this turn: ${availableArtifactTools.join(", ")}.`,
      "Artifacts are optional deliverables, not mandatory outputs. Use an artifact tool only when the user asks for a distinct reusable result such as a presentation, image, video presentation, web page, visualization, or other standalone asset.",
      "Do not create or publish artifacts for greetings, brief explanations, ordinary Q&A, short code snippets, or discussion about how to make an artifact.",
      "When an artifact publisher is needed, call it only after the underlying artifact source has actually been generated and is ready. If publishing fails with a recoverable tool result, explain or correct it instead of treating the whole turn as a system failure.",
    );
    lines.push(...artifactToolLines);
  }

  const availableMcpTools = input.availableMcpTools ?? [];
  if (availableMcpTools.length > 0) {
    lines.push(
      `Available MCP tools this turn: ${availableMcpTools.join(", ")}.`,
      "MCP tools may call external services configured by the workspace. Use them only when they are relevant to the user's request.",
    );
  }

  for (const provider of input.toolRuntimePromptProviders ?? []) {
    const output = provider({ currentDate });
    const providerLines = Array.isArray(output) ? output : [output];
    lines.push(...providerLines.filter((line) => line.trim().length > 0));
  }

  return lines.join("\n");
}
