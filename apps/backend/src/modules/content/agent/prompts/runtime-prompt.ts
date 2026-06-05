import type { CommandSuccessCriteria, PreparedThreadTurn } from "../../threads";
import type { VirtualFsSource } from "../../virtual-fs/types";
import { AGENT_TOOL_NAMES } from "../tool-registry";
import { sanitizeNonCitableCitationMarkers } from "../fs-utils";
import { formatDateInTimeZone } from "../turn/output-normalizer";
import { artifactToolRuntimePromptProviders } from "./artifact-tool-prompt-registry";
import type { RuntimePromptContext } from "./tool-prompt-provider";

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
    "Do not synthesize /work/<filename> for @mentions or source filenames. /work contains only thread Workfiles.",
    ...input.sources.map(formatRuntimeSourceReference),
    input.omittedCount > 0
      ? `- ${input.omittedCount} additional source entries omitted from this manifest; use ls('/kb') if you need to enumerate them.`
      : null,
    "</selected_source_manifest>",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildInvokedSkillsRuntimePrompt(input: {
  enabledSkills: PreparedThreadTurn["enabledSkills"];
  invokedSkillIds: string[];
}) {
  if (input.invokedSkillIds.length === 0) {
    return "";
  }
  const invokedSkillIdSet = new Set(input.invokedSkillIds);
  const invokedSkills = input.enabledSkills.filter((skill) =>
    invokedSkillIdSet.has(skill.workspaceSkillId),
  );
  if (invokedSkills.length === 0) {
    return "";
  }

  return [
    "<user_invoked_skills>",
    "The user explicitly invoked these skills for this turn. This is a strong instruction, not a suggestion: apply the loaded SKILL.md workflow when answering unless it conflicts with higher-priority system rules. Use /skills only for supporting files or additional details.",
    ...invokedSkills.flatMap((skill) => {
      const skillPath = `/skills/${skill.name}/SKILL.md`;
      const skillContent = skill.files.find(
        (file) => file.path === "SKILL.md",
      )?.contentText;
      const header = [
        `- name="${escapeRuntimeValue(skill.name)}"`,
        `description="${escapeRuntimeValue(skill.description)}"`,
        `skill_path="${escapeRuntimeValue(skillPath)}"`,
      ].join(" ");
      const safeContent = skillContent
        ? sanitizeNonCitableCitationMarkers(skillContent).trim()
        : "";
      if (!safeContent) {
        return [
          header,
          `  Could not preload SKILL.md content. Read ${skillPath} from /skills before answering.`,
        ];
      }
      return [
        header,
        `  <skill_content path="${escapeRuntimeValue(skillPath)}">`,
        safeContent,
        "  </skill_content>",
      ];
    }),
    "</user_invoked_skills>",
  ].join("\n");
}

function buildCommandSuccessInstruction(criteria: CommandSuccessCriteria) {
  switch (criteria.kind) {
    case "none":
      return "";
    case "artifact":
      return `Command success requires creating a ${criteria.artifactType} artifact by completing ${criteria.toolName}. The command tool_choice policy will force this tool after any support tool call or if the model tries to finish with text only.`;
    case "tool_call":
      return `Command success requires calling ${criteria.toolName}. The command tool_choice policy will force this tool after any support tool call or if the model tries to finish with text only.`;
  }
}

export interface SandboxRuntimePromptCapabilities {
  prepareToolAvailable: boolean;
  executeAvailable: boolean;
  collectToolAvailable: boolean;
}

function buildSandboxRuntimePrompt(
  capabilities: SandboxRuntimePromptCapabilities | undefined,
) {
  if (!capabilities?.executeAvailable) {
    return "";
  }
  const bridgeInstructions = [
    capabilities.prepareToolAvailable
      ? `- ${AGENT_TOOL_NAMES.prepareSandboxWorkspace} copies selected /work files into sandbox /workspace/input or /workspace/work.`
      : null,
    `- ${AGENT_TOOL_NAMES.execute} runs inside sandbox /workspace by default and always requires confirmation.`,
    capabilities.collectToolAvailable
      ? `- ${AGENT_TOOL_NAMES.collectSandboxOutputs} copies selected sandbox outputs back to /work. Artifact collection is handled only when the artifact pipeline supports it.`
      : null,
  ].filter((line): line is string => line !== null);

  const virtualPathExecutionRule = capabilities.prepareToolAvailable
    ? `- Do not pass /work or /kb paths directly to ${AGENT_TOOL_NAMES.execute}; they are SourceWeft virtual filesystem paths, not sandbox filesystem paths. Use ${AGENT_TOOL_NAMES.prepareSandboxWorkspace} first when command execution needs /work files.`
    : `- Do not pass /work or /kb paths directly to ${AGENT_TOOL_NAMES.execute}; they are SourceWeft virtual filesystem paths, not sandbox filesystem paths.`;

  return `<sandbox_rules>
- /work is SourceWeft's durable working area for plans, drafts, chapters, settings, extracted tables, scripts, and reusable intermediate materials.
- Sandbox /workspace is an isolated temporary execution environment.
- Do not treat sandbox files as durable unless they are collected back to /work or published as artifacts.
- Use /work for long-lived creative or analytical working files.
- Use the sandbox only when command execution, dependency installation, format conversion, batch processing, testing, or computation is needed.
${bridgeInstructions.join("\n")}
- Commands needing prepared files should explicitly work under /workspace/input or /workspace/work.
${virtualPathExecutionRule}
- Enabled sandbox skills may be staged under /skills/<skill-name>; commands may execute /skills files when the skill instructions call for it.
- Sandbox outputs are not durable until collected back to /work or published through an artifact pipeline.
- /kb remains SourceWeft source evidence and is not mounted or directly copied into the sandbox.
- If /kb content needs command processing, extract the minimum necessary content into /work first.
- Prepared files and sandbox outputs are not citable evidence.
- Verify factual claims against /kb, retrieval, web, or another citable source before final answers.
- Never attempt to inspect secrets, credentials, environment variables, host files, or connector tokens.
</sandbox_rules>`;
}

export function buildAgentRuntimePrompt(input: {
  availableWebTools?: string[];
  availableArtifactTools?: string[];
  availableMcpTools?: string[];
  artifactIntent?: PreparedThreadTurn["artifactIntent"];
  generatePptxTool?: PreparedThreadTurn["generatePptxTool"];
  generateVideoPresentationTool?: PreparedThreadTurn["generateVideoPresentationTool"];
  commandSuccessCriteria?: PreparedThreadTurn["commandSuccessCriteria"];
  enabledSkills?: PreparedThreadTurn["enabledSkills"];
  invokedSkillIds?: string[];
  sandboxRuntime?: SandboxRuntimePromptCapabilities;
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
  const invokedSkillsPrompt = buildInvokedSkillsRuntimePrompt({
    enabledSkills: input.enabledSkills ?? [],
    invokedSkillIds: input.invokedSkillIds ?? [],
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
    artifactIntent: input.artifactIntent,
    generatePptxTool: input.generatePptxTool,
    generateVideoPresentationTool: input.generateVideoPresentationTool,
  };
  const artifactToolLines = artifactToolRuntimePromptProviders.flatMap(
    (provider) => provider.buildLines(providerContext),
  );
  if (artifactToolLines.length > 0) {
    lines.push(
      `Available artifact tools this turn: ${availableArtifactTools.join(", ")}.`,
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

  const sandboxPrompt = buildSandboxRuntimePrompt(input.sandboxRuntime);
  if (sandboxPrompt) {
    lines.push(sandboxPrompt);
  }

  return lines.join("\n");
}
