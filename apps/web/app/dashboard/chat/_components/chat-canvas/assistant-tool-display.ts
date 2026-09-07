import { getAgentToolSlashCommand } from "@sourceweft/agent-tool-registry";
import {
  getConnectorToolDisplayLabel,
  getToolApprovalDisplayLabel,
} from "./reasoning-trace-state";
import { getWorkfileMutationToolTitle } from "./workfile-mutation-state";
import type {
  ThinkingStepRecord,
  ToolCallRecord,
  ToolConfirmationResolution,
} from "./types";
import { getRecordValue } from "../../../../../lib/records";
import {
  getUserQuestionDisplay,
  isUserQuestionTool,
} from "./user-question-display";

function formatToolName(toolName: string) {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getToolDisplayName(toolName: string) {
  return (
    getAgentToolSlashCommand(toolName)?.displayName ?? formatToolName(toolName)
  );
}

export function getSkillInstructionReadFileLabel(toolCall: ToolCallRecord) {
  const inputFileName = getRecordValue(toolCall.input, "skillFileName");
  if (typeof inputFileName === "string" && inputFileName.trim().length > 0) {
    return inputFileName.trim();
  }

  const output = isObjectRecord(toolCall.output) ? toolCall.output : null;
  const outputFileName = getRecordValue(output ?? undefined, "skillFileName");
  if (typeof outputFileName === "string" && outputFileName.trim().length > 0) {
    return outputFileName.trim();
  }

  const inputSkillPath = getRecordValue(toolCall.input, "skillPath");
  if (typeof inputSkillPath === "string" && inputSkillPath.trim().length > 0) {
    return inputSkillPath.trim();
  }

  const outputSkillPath = getRecordValue(output ?? undefined, "skillPath");
  if (
    typeof outputSkillPath === "string" &&
    outputSkillPath.trim().length > 0
  ) {
    return outputSkillPath.trim();
  }

  return resolveFilesystemPath(toolCall.input);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveFilesystemPath(input: Record<string, unknown> | undefined) {
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input?.[key];
    if (typeof value !== "string") {
      continue;
    }
    const path = value.trim();
    if (path === "/skills" || path.startsWith("/skills/")) {
      return path;
    }
  }
  return null;
}

function getSkillInstructionDisplayName(
  input: Record<string, unknown> | undefined,
) {
  const displayName = getRecordValue(input, "skillDisplayName");
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    return displayName.trim();
  }

  const skillSlug = getRecordValue(input, "skillSlug");
  if (typeof skillSlug === "string" && skillSlug.trim().length > 0) {
    return formatToolName(skillSlug.trim());
  }

  const path = resolveFilesystemPath(input);
  if (!path?.startsWith("/skills/")) {
    return null;
  }

  const pathSkillSlug = path.slice("/skills/".length).split("/")[0]?.trim();
  return pathSkillSlug ? formatToolName(pathSkillSlug) : null;
}

export function isRedactedSkillInstructionRead(toolCall: ToolCallRecord) {
  const output = isObjectRecord(toolCall.output) ? toolCall.output : null;
  const filesystemScope = getRecordValue(toolCall.input, "filesystemScope");
  const visibility = getRecordValue(toolCall.input, "visibility");
  return (
    toolCall.tool === "read_file" &&
    ((output?.type === "skill_instruction_read" && output.redacted === true) ||
      (filesystemScope === "skills" && visibility === "internal_instruction") ||
      Boolean(resolveFilesystemPath(toolCall.input)))
  );
}

function getStepDisplayTitle(toolStep?: ThinkingStepRecord) {
  const visibility = getRecordValue(toolStep?.metadata, "visibility");
  const filesystemScope = getRecordValue(toolStep?.metadata, "filesystemScope");
  if (
    typeof toolStep?.title === "string" &&
    toolStep.title.trim().length > 0 &&
    (visibility === "internal_instruction" ||
      filesystemScope === "skills" ||
      filesystemScope === "work" ||
      filesystemScope === "sources")
  ) {
    return toolStep.title.trim();
  }
  return null;
}

/**
 * The bundle-relative file a skill read is actually opening.
 *
 * Progressive disclosure means one skill is normally read several times in a
 * turn: SKILL.md first, then whichever reference files it points at. Labelling
 * every one of them "Load X skill instructions" made that look like the agent
 * repeating itself — three identical rows for three different files — when it
 * was working exactly as designed. The path is already in the tool input (it is
 * how we derive the skill's name); only the file BODY is redacted, so naming
 * the file leaks nothing and turns the repeats back into a legible sequence.
 *
 * SKILL.md returns null: it is the instructions, so the plain label is right.
 */
function getSkillBundleFileName(
  input: Record<string, unknown> | undefined,
): string | null {
  const path = resolveFilesystemPath(input);
  if (!path?.startsWith("/skills/")) {
    return null;
  }
  const relative = path.slice("/skills/".length).split("/").slice(1).join("/");
  if (!relative || relative === "SKILL.md") {
    return null;
  }
  return relative;
}

export function getAssistantToolTitle(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
  confirmationResolution?: ToolConfirmationResolution | null,
) {
  if (isUserQuestionTool(toolCall.tool)) {
    return getUserQuestionDisplay(toolCall).title;
  }
  if (isRedactedSkillInstructionRead(toolCall)) {
    const skillDisplayName = getSkillInstructionDisplayName(toolCall.input);
    const bundleFile = getSkillBundleFileName(toolCall.input);
    if (skillDisplayName && bundleFile) {
      return toolCall.status === "running"
        ? `Reading ${bundleFile} from ${skillDisplayName}`
        : `Read ${bundleFile} from ${skillDisplayName}`;
    }
    if (skillDisplayName) {
      return toolCall.status === "running"
        ? `Loading ${skillDisplayName} skill instructions`
        : `Load ${skillDisplayName} skill instructions`;
    }
    return toolCall.status === "running"
      ? "Loading skill instructions"
      : "Load skill instructions";
  }

  const workfileMutationTitle = getWorkfileMutationToolTitle(toolCall);
  if (workfileMutationTitle) {
    return workfileMutationTitle;
  }

  const stepTitle = getStepDisplayTitle(toolStep);
  if (stepTitle) {
    return stepTitle
      .replace(/\s+(completed|done|running|failed|errored)$/i, "")
      .trim();
  }

  const title =
    getToolApprovalDisplayLabel(toolCall, confirmationResolution) ??
    getConnectorToolDisplayLabel(toolCall) ??
    getToolDisplayName(toolCall.tool);

  return title
    .replace(/\s+(completed|done|running|failed|errored)$/i, "")
    .trim();
}
