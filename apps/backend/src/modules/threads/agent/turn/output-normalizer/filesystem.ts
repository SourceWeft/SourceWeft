/**
 * Everything the filesystem tool family needs to describe itself: which scope a
 * call touches, the skill-instruction display metadata and the client-side
 * redaction that metadata drives, the presenter table behind start/end titles,
 * and the metadata, failure and description extraction done on tool output.
 *
 * The skill-instruction layer is not separable from the rest: the titles and
 * the trace sanitization are two consumers of the same private metadata
 * resolution, so splitting them would only trade a large file for a cycle.
 */
import { toObjectRecord } from "../../../../../shared/records";
import {
  AGENT_TOOL_NAMES,
  getAgentToolPresentation,
  hasAgentToolCapability,
} from "@sourceweft/agent-tool-registry";
import {
  extractToolOutputField,
  extractToolOutputText,
  getPublicStringField,
} from "./json";

export function resolveFilesystemPath(input: Record<string, unknown>) {
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

export function resolveFilesystemPattern(input: Record<string, unknown>) {
  const value = input.pattern;
  return typeof value === "string" ? value.trim() : "";
}

export function scopeFromPath(path: string) {
  if (path === "/skills" || path.startsWith("/skills/")) {
    return "skills";
  }
  if (path === "/workfiles" || path.startsWith("/workfiles/")) {
    return "work";
  }
  return null;
}

export function filesystemScope(
  input: Record<string, unknown>,
  toolName?: string,
) {
  const declaredScope = input.filesystemScope;
  if (
    declaredScope === "skills" ||
    declaredScope === "work" ||
    declaredScope === "sources"
  ) {
    return declaredScope;
  }
  const pathScope = scopeFromPath(resolveFilesystemPath(input));
  if (pathScope) {
    return pathScope;
  }
  if (toolName && hasAgentToolCapability(toolName, "pattern_scope")) {
    const patternScope = scopeFromPath(resolveFilesystemPattern(input));
    if (patternScope) {
      return patternScope;
    }
  }
  return "sources";
}

export type FilesystemToolScope = ReturnType<typeof filesystemScope>;

export type FilesystemToolVisibility = "internal_instruction" | "normal";

export type SkillInstructionDisplayMetadata = {
  skillSlug: string;
  skillDisplayName: string;
  skillFileName?: string;
  skillPath?: string;
};

export type SkillInstructionDisplayOptions = {
  skillDisplayNamesBySlug?: ReadonlyMap<string, string>;
};

export type SkillInstructionReadOutput = {
  type: "skill_instruction_read";
  redacted: true;
  skillFileName?: string;
  skillPath?: string;
};

export const SKILL_INSTRUCTION_READ_OUTPUT = {
  type: "skill_instruction_read",
  redacted: true,
} satisfies SkillInstructionReadOutput;

function formatSkillSlugForDisplay(slug: string) {
  return slug
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getSkillInstructionDisplayMetadataFromPath(
  path: string,
  options: SkillInstructionDisplayOptions = {},
): SkillInstructionDisplayMetadata | null {
  if (!path.startsWith("/skills/")) {
    return null;
  }

  const skillSlug = path.slice("/skills/".length).split("/")[0]?.trim();
  if (!skillSlug) {
    return null;
  }

  const skillPath = path.startsWith("/skills/") ? path : undefined;
  const skillFileName = skillPath?.split("/").at(-1)?.trim() || undefined;

  return {
    skillSlug,
    skillDisplayName:
      options.skillDisplayNamesBySlug?.get(skillSlug) ??
      formatSkillSlugForDisplay(skillSlug),
    ...(skillFileName ? { skillFileName } : {}),
    ...(skillPath ? { skillPath } : {}),
  };
}

function getSkillInstructionDisplayMetadataFromText(
  value: unknown,
): SkillInstructionDisplayMetadata | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/\/skills\/([^/\s"')\]}]+)(?:\/[^\s"')\]}]*)?/);
  const skillSlug = match?.[1]?.trim();
  const skillPath = match?.[0]?.replace(/[),.;:]+$/g, "");
  const skillFileName = skillPath?.startsWith(`/skills/${skillSlug}/`)
    ? skillPath.split("/").at(-1)?.trim()
    : undefined;
  return skillSlug
    ? {
        skillSlug,
        skillDisplayName: formatSkillSlugForDisplay(skillSlug),
        ...(skillFileName ? { skillFileName } : {}),
        ...(skillPath ? { skillPath } : {}),
      }
    : null;
}

export function getSkillInstructionDisplayMetadata(
  input: Record<string, unknown> | undefined,
  options: SkillInstructionDisplayOptions = {},
): SkillInstructionDisplayMetadata | null {
  if (!input) {
    return null;
  }

  const existingSlug = getPublicStringField(input, "skillSlug");
  const existingDisplayName = getPublicStringField(input, "skillDisplayName");
  const existingFileName = getPublicStringField(input, "skillFileName");
  const existingPath = getPublicStringField(input, "skillPath");
  if (existingSlug && existingDisplayName) {
    const pathMetadata = getSkillInstructionDisplayMetadataFromPath(
      resolveFilesystemPath(input),
      options,
    );
    return {
      skillSlug: existingSlug,
      skillDisplayName: existingDisplayName,
      ...(existingFileName || pathMetadata?.skillFileName
        ? {
            skillFileName: existingFileName ?? pathMetadata?.skillFileName,
          }
        : {}),
      ...(existingPath || pathMetadata?.skillPath
        ? { skillPath: existingPath ?? pathMetadata?.skillPath }
        : {}),
    };
  }

  return getSkillInstructionDisplayMetadataFromPath(
    resolveFilesystemPath(input),
    options,
  );
}

function getSkillInstructionTitle(
  action: "Loading" | "Load",
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
) {
  const skillMetadata = getSkillInstructionDisplayMetadata(input, options);
  return skillMetadata
    ? `${action} ${skillMetadata.skillDisplayName} skill instructions`
    : `${action} skill instructions`;
}

function isFilesystemToolWithPresenter(toolName: string) {
  return Boolean(getFilesystemToolPresenter(toolName));
}

export function getFilesystemToolClientMetadata(
  toolName: string,
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
): {
  filesystemScope: FilesystemToolScope;
  visibility: FilesystemToolVisibility;
} & Partial<SkillInstructionDisplayMetadata> {
  const scope = filesystemScope(input, toolName);
  return {
    filesystemScope: scope,
    visibility: scope === "skills" ? "internal_instruction" : "normal",
    ...(scope === "skills"
      ? (getSkillInstructionDisplayMetadata(input, options) ?? {})
      : {}),
  };
}

export function shouldRedactFilesystemToolForClient(
  toolName: string,
  input: Record<string, unknown> | undefined,
  options: SkillInstructionDisplayOptions = {},
) {
  return Boolean(
    input &&
    isFilesystemToolWithPresenter(toolName) &&
    getFilesystemToolClientMetadata(toolName, input, options).visibility ===
      "internal_instruction",
  );
}

export function sanitizeFilesystemToolInputForClient(
  toolName: string,
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
) {
  if (!shouldRedactFilesystemToolForClient(toolName, input, options)) {
    return input;
  }
  return {
    filesystemScope: "skills" as const,
    redacted: true,
    visibility: "internal_instruction" as const,
    ...(getSkillInstructionDisplayMetadata(input, options) ?? {}),
  };
}

export function redactFilesystemToolOutputForClient(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: unknown,
  options: SkillInstructionDisplayOptions = {},
) {
  if (!shouldRedactFilesystemToolForClient(toolName, input, options)) {
    return output;
  }

  const metadata = getSkillInstructionDisplayMetadata(input, options);
  return {
    ...SKILL_INSTRUCTION_READ_OUTPUT,
    ...(metadata?.skillFileName
      ? { skillFileName: metadata.skillFileName }
      : {}),
    ...(metadata?.skillPath ? { skillPath: metadata.skillPath } : {}),
  };
}

function getTraceToolName(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function sanitizeFilesystemToolTraceRecordForClient(value: unknown) {
  const record = toObjectRecord(value);
  const tool = getTraceToolName(record?.tool);
  const input = toObjectRecord(record?.input);
  if (!record || !tool || !input) {
    return value;
  }

  return {
    ...record,
    input: sanitizeFilesystemToolInputForClient(tool, input),
    output: redactFilesystemToolOutputForClient(tool, input, record.output),
    ...(shouldRedactFilesystemToolForClient(tool, input)
      ? { title: getSkillInstructionTitle("Load", input) }
      : {}),
  };
}

function sanitizeThinkingStepForClient(value: unknown) {
  const record = toObjectRecord(value);
  const metadata = toObjectRecord(record?.metadata);
  const skillMetadata =
    getSkillInstructionDisplayMetadata(metadata ?? undefined) ??
    getSkillInstructionDisplayMetadataFromText(record?.title);
  if (
    !record ||
    (metadata?.visibility !== "internal_instruction" &&
      metadata?.filesystemScope !== "skills")
  ) {
    return value;
  }

  const sanitized: Record<string, unknown> = {
    ...record,
    items: [],
    title: skillMetadata
      ? `Load ${skillMetadata.skillDisplayName} skill instructions`
      : "Load skill instructions",
    metadata: {
      ...metadata,
      filesystemScope: "skills",
      visibility: "internal_instruction",
      redacted: true,
      ...(skillMetadata ?? {}),
    },
  };
  delete sanitized.detail;
  delete sanitized.description;
  return sanitized;
}

export function sanitizeThreadMessageMetadataForClient(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    ...(Array.isArray(metadata.toolCalls)
      ? {
          toolCalls: metadata.toolCalls.map(
            sanitizeFilesystemToolTraceRecordForClient,
          ),
        }
      : {}),
    ...(Array.isArray(metadata.traceParts)
      ? {
          traceParts: metadata.traceParts.map(
            sanitizeFilesystemToolTraceRecordForClient,
          ),
        }
      : {}),
    ...(Array.isArray(metadata.thinkingSteps)
      ? {
          thinkingSteps: metadata.thinkingSteps.map(
            sanitizeThinkingStepForClient,
          ),
        }
      : {}),
  };
}

export const FILESYSTEM_TOOL_PRESENTERS = {
  [AGENT_TOOL_NAMES.ls]: {
    start: {
      work: "Listing Workfiles",
      skills: "Listing selected skills",
      sources: "Listing selected sources",
    },
    end: {
      work: "Listed Workfiles",
      skills: "Listed selected skills",
      sources: "Listed selected sources",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.resultCount === "number"
        ? `Listed ${input.metadata.resultCount} entries.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.glob]: {
    start: {
      work: "Finding matching Workfiles",
      skills: "Finding matching skill files",
      sources: "Finding matching sources",
    },
    end: {
      work: "Found matching Workfiles",
      skills: "Found matching skill files",
      sources: "Found matching sources",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.resultCount === "number"
        ? `Found ${input.metadata.resultCount} matching paths.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.grep]: {
    start: {
      work: "Searching Workfiles",
      skills: "Searching skill instructions",
      sources: "Searching exact terms",
    },
    end: {
      work: "Searched Workfiles",
      skills: "Searched skill instructions",
      sources: "Searched exact terms",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.matchCount === "number"
        ? `Found ${input.metadata.matchCount} text matches.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.readFile]: {
    start: {
      work: "Reading Workfile",
      skills: "Loading skill instructions",
      sources: "Reading source content",
    },
    end: {
      work: "Read Workfile",
      skills: "Load skill instructions",
      sources: "Read source content",
    },
    describe: (input: {
      metadata: Record<string, unknown>;
      scope: ReturnType<typeof filesystemScope>;
      input?: Record<string, unknown>;
    }) => {
      const inputLimit = toObjectRecord(input.input)?.limit;
      if (input.scope === "sources") {
        const lineLimit =
          typeof inputLimit === "number" && Number.isFinite(inputLimit)
            ? Math.max(1, Math.floor(inputLimit))
            : undefined;
        return lineLimit
          ? `Read up to ${lineLimit} source lines.`
          : "Read source content.";
      }
      if (typeof input.metadata.chunkCount === "number") {
        const noun = input.scope === "skills" ? "skill" : "Workfile";
        return `Read ${input.metadata.chunkCount} ${noun} ${
          input.metadata.chunkCount === 1 ? "chunk" : "chunks"
        }.`;
      }
      return undefined;
    },
  },
} as const;

export function getFilesystemToolPresenter(toolName: string) {
  return FILESYSTEM_TOOL_PRESENTERS[
    toolName as keyof typeof FILESYSTEM_TOOL_PRESENTERS
  ];
}

export function getFilesystemToolStartTitle(
  toolName: string,
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
) {
  const presentation = getAgentToolPresentation(toolName);
  if (presentation) {
    return presentation.title({
      toolInput: input,
      readOutputField: extractToolOutputField,
      status: "running",
    });
  }
  const scope = filesystemScope(input, toolName);
  if (scope === "skills" && toolName === AGENT_TOOL_NAMES.readFile) {
    return getSkillInstructionTitle("Loading", input, options);
  }
  return getFilesystemToolPresenter(toolName)?.start[scope] ?? null;
}

export function getFilesystemToolEndTitle(
  toolName: string,
  input: Record<string, unknown>,
  output?: unknown,
  options: SkillInstructionDisplayOptions = {},
) {
  const presentation = getAgentToolPresentation(toolName);
  if (presentation) {
    return presentation.title({
      toolInput: input,
      toolOutput: output,
      readOutputField: extractToolOutputField,
      status: "completed",
    });
  }
  const scope = filesystemScope(input, toolName);
  if (scope === "skills" && toolName === AGENT_TOOL_NAMES.readFile) {
    return getSkillInstructionTitle("Load", input, options);
  }
  return getFilesystemToolPresenter(toolName)?.end[scope] ?? null;
}

export function getFilesystemToolOutputError(
  toolName: string,
  output: unknown,
) {
  if (!hasAgentToolCapability(toolName, "sandbox_execute")) {
    return null;
  }

  const outputRecord = toObjectRecord(output);
  const directError =
    typeof outputRecord?.error === "string" ? outputRecord.error.trim() : "";
  if (directError.length > 0) {
    return directError;
  }

  const structuredFailureCode =
    typeof outputRecord?.failureCode === "string"
      ? outputRecord.failureCode.trim()
      : typeof outputRecord?.errorCode === "string"
        ? outputRecord.errorCode.trim()
        : "";
  if (
    structuredFailureCode === "SANDBOX_EXECUTE_COMMAND_DENIED" ||
    structuredFailureCode === "SANDBOX_EXECUTE_CWD_DENIED" ||
    structuredFailureCode === "SANDBOX_EXECUTE_VFS_PATH_DENIED" ||
    structuredFailureCode === "SANDBOX_SKILL_STAGING_UNAVAILABLE"
  ) {
    return structuredFailureCode;
  }

  const outputText = extractToolOutputText(output);
  const commandOutput =
    typeof outputRecord?.output === "string" ? outputRecord.output : "";
  const combinedOutputText = [outputText, commandOutput]
    .filter((item): item is string => Boolean(item))
    .join("\n");
  if (!combinedOutputText) {
    return null;
  }

  const deniedMatch = combinedOutputText.match(
    /(SANDBOX_(?:EXECUTE_(?:COMMAND|CWD|VFS_PATH)_DENIED|SKILL_STAGING_UNAVAILABLE):[^\n]*)/u,
  );
  if (deniedMatch?.[1]) {
    return deniedMatch[1].trim();
  }

  if (
    typeof outputRecord?.exitCode === "number" &&
    Number.isFinite(outputRecord.exitCode) &&
    outputRecord.exitCode !== 0
  ) {
    return `Command failed with exit code ${outputRecord.exitCode}.`;
  }

  const exitMatch = combinedOutputText.match(
    /\[Command failed with exit code (-?\d+)\]/u,
  );
  return exitMatch?.[1]
    ? `Command failed with exit code ${exitMatch[1]}.`
    : null;
}

export function getFilesystemToolFailureMetadata(
  toolName: string,
  output: unknown,
) {
  if (!hasAgentToolCapability(toolName, "sandbox_execute")) {
    return {};
  }
  const record = toObjectRecord(output);
  if (!record) {
    const outputText = extractToolOutputText(output);
    return outputText ? extractExecuteFailureMetadataFromText(outputText) : {};
  }

  const commandFingerprint =
    typeof record.commandFingerprint === "string"
      ? record.commandFingerprint.trim()
      : undefined;
  const failureCode =
    typeof record.failureCode === "string"
      ? record.failureCode.trim()
      : typeof record.errorCode === "string"
        ? record.errorCode.trim()
        : undefined;
  const repeatCount =
    typeof record.repeatCount === "number" &&
    Number.isFinite(record.repeatCount)
      ? record.repeatCount
      : undefined;
  const runId =
    typeof record.runId === "string" ? record.runId.trim() : undefined;
  const outputText = extractToolOutputText(output);
  const textMetadata = outputText
    ? extractExecuteFailureMetadataFromText(outputText)
    : {};

  return {
    ...textMetadata,
    ...(commandFingerprint ? { commandFingerprint } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(repeatCount !== undefined ? { repeatCount } : {}),
    ...(runId ? { runId } : {}),
  };
}

function safeExecuteFailureMessage(outputText: string) {
  const firstLine = outputText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (
    firstLine?.startsWith("SANDBOX_EXECUTE_COMMAND_DENIED:") ||
    firstLine?.startsWith("SANDBOX_EXECUTE_CWD_DENIED:") ||
    firstLine?.startsWith("SANDBOX_EXECUTE_VFS_PATH_DENIED:") ||
    firstLine?.startsWith("SANDBOX_SKILL_STAGING_UNAVAILABLE:")
  ) {
    return firstLine;
  }
  return undefined;
}

function safeExecuteFailureHint(outputText: string) {
  const match = outputText.match(/^Hint:\s+(.+)$/mu);
  return match?.[1]?.trim() || undefined;
}

function extractExecuteFailureMetadataFromText(outputText: string) {
  const diagnosticsMatch = outputText.match(/^Diagnostics:\s+(.+)$/mu);
  const fields = diagnosticsMatch?.[1]
    ? Object.fromEntries(
        [
          ...diagnosticsMatch[1].matchAll(/([A-Za-z][A-Za-z0-9]*)=([^\s]+)/gu),
        ].map((match) => [match[1], match[2]] as const),
      )
    : {};
  const repeatCount = Number(fields.repeatCount);
  const failureMessage = safeExecuteFailureMessage(outputText);
  const failureHint = failureMessage
    ? safeExecuteFailureHint(outputText)
    : undefined;
  return {
    ...(failureMessage ? { failureMessage } : {}),
    ...(failureHint ? { failureHint } : {}),
    ...(fields.commandFingerprint
      ? { commandFingerprint: fields.commandFingerprint }
      : {}),
    ...(fields.failureCode ? { failureCode: fields.failureCode } : {}),
    ...(Number.isFinite(repeatCount) ? { repeatCount } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
  };
}

export function getFilesystemToolMetadata(toolName: string, output: unknown) {
  const record = toObjectRecord(output);
  const metadata: Record<string, unknown> = {};

  if (record?.redacted === true && record.type === "skill_instruction_read") {
    metadata.redacted = true;
    metadata.visibility = "internal_instruction";
    metadata.filesystemScope = "skills";
    return metadata;
  }

  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
    const outputText = extractToolOutputText(output) ?? "";
    const artifactId = outputText.match(/artifact_id:\s*(\S+)/)?.[1];
    const artifactUrl = outputText.match(/artifact_url:\s*(\S+)/)?.[1];
    if (artifactId) {
      metadata.artifactId = artifactId;
    }
    if (artifactUrl) {
      metadata.artifactUrl = artifactUrl;
    }
    return metadata;
  }

  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
    const artifactId = extractToolOutputField(output, "artifact_id");
    const pptxUrl =
      extractToolOutputField(output, "artifact_url") ??
      extractToolOutputField(output, "pptx_url");
    const title = extractToolOutputField(output, "title");
    const resultType = extractToolOutputField(output, "type");
    const status = extractToolOutputField(output, "status");
    if (artifactId) {
      metadata.artifactId = artifactId;
    }
    if (pptxUrl) {
      metadata.artifactUrl = pptxUrl;
    }
    if (title) {
      metadata.title = title;
    }
    if (resultType) {
      metadata.resultType = resultType;
    }
    if (status) {
      metadata.status = status;
    }
    return metadata;
  }

  if (record && Array.isArray(record.files)) {
    metadata.resultCount = record.files.length;
  }
  if (record && Array.isArray(record.matches)) {
    metadata.matchCount = record.matches.length;
  }
  const outputText = extractToolOutputText(output);
  if (outputText) {
    const chunkMatches = outputText.match(/--- chunk |^Chunk:/gm);
    if (chunkMatches && chunkMatches.length > 0) {
      metadata.chunkCount = chunkMatches.length;
    }
    metadata.truncated = outputText.includes("Output truncated.");
  }

  if (
    hasAgentToolCapability(toolName, "read_tool_output") &&
    metadata.chunkCount === undefined
  ) {
    metadata.chunkCount = 1;
  }

  return metadata;
}

export function getFilesystemToolDescription(
  toolName: string,
  metadata: Record<string, unknown>,
  input?: Record<string, unknown>,
) {
  const scope = input ? filesystemScope(input, toolName) : "sources";
  const presentation = getAgentToolPresentation(toolName);
  if (presentation?.describe) {
    return presentation.describe({
      toolInput: input ?? {},
      metadata,
      readOutputField: extractToolOutputField,
    });
  }
  return getFilesystemToolPresenter(toolName)?.describe({
    metadata,
    scope,
    input,
  });
}
