import type { CommandExecutionPolicy } from "..";
import type {
  CommandSuccessCriteria,
  PreparedThreadTurn,
  ToolCallTrace,
} from "../../threads";
import { AGENT_TOOL_NAMES } from "../tool-registry";
import { looksLikePresentationSpecText } from "../tools/generate-pptx-tool";
import { looksLikeVideoPresentationSpecText } from "../tools/generate-video-presentation-tool";
import {
  extractToolOutputField,
  hasVideoPresentationArtifactResult,
} from "./output-normalizer";
import {
  looksLikeArtifactUrlLeakText,
  looksLikeRawToolCallText,
} from "./tool-utils";

export function isCommandSuccessSatisfied(input: {
  criteria: CommandSuccessCriteria;
  toolCalls: ToolCallTrace[];
}) {
  const { criteria } = input;
  switch (criteria.kind) {
    case "none":
      return true;
    case "artifact":
      return input.toolCalls.some((call) => {
        if (
          call.tool !== criteria.toolName ||
          call.status !== "completed" ||
          call.error
        ) {
          return false;
        }
        if (criteria.artifactType === "slides") {
          return Boolean(
            extractToolOutputField(call.output, "pptx_url") ||
              extractToolOutputField(call.output, "artifact_url"),
          );
        }
        if (criteria.artifactType === "video_presentation") {
          return hasVideoPresentationArtifactResult(call.output);
        }
        if (criteria.artifactType !== "image") {
          return true;
        }
        return Boolean(extractToolOutputField(call.output, "artifact_url"));
      });
    case "tool_call":
      return input.toolCalls.some(
        (call) =>
          call.tool === criteria.toolName &&
          call.status === "completed" &&
          !call.error,
      );
  }
}

export function commandSuccessFailureText(
  criteria: CommandSuccessCriteria,
  toolCalls: ToolCallTrace[] = [],
) {
  switch (criteria.kind) {
    case "none":
      return "Command failed because its success criteria were not satisfied.";
    case "artifact":
      if (toolCalls.some((call) => call.tool === criteria.toolName)) {
        return `Command failed because ${criteria.toolName} did not create a ${criteria.artifactType} artifact.`;
      }
      return `Command failed because ${criteria.toolName} was not called under command tool_choice policy.`;
    case "tool_call":
      if (toolCalls.some((call) => call.tool === criteria.toolName)) {
        return `Command failed because ${criteria.toolName} did not complete successfully.`;
      }
      return `Command failed because ${criteria.toolName} was not called under command tool_choice policy.`;
  }
}

export function commandExecutionPolicyFor(
  prepared: PreparedThreadTurn,
): CommandExecutionPolicy | undefined {
  const criteria = prepared.commandSuccessCriteria;
  if (prepared.command?.workflow?.execution !== "agent") {
    return undefined;
  }
  if (criteria.kind === "none") {
    return undefined;
  }
  return {
    targetToolName: criteria.toolName,
    mode:
      prepared.command?.kind === "tool" ? "force_target" : "auto_then_force",
  };
}

export function shouldSuppressRawToolCallText(input: {
  assistantContent: string;
  criteria: CommandSuccessCriteria;
  delta: string;
  suppressing: boolean;
}) {
  if (input.criteria.kind === "none") {
    return false;
  }
  if (input.suppressing) {
    return true;
  }
  if (input.assistantContent.trim().length > 0) {
    return false;
  }
  return looksLikeRawToolCallText(input.delta);
}

export function shouldSuppressLeakedCommandSpecText(input: {
  assistantContent: string;
  criteria: CommandSuccessCriteria;
  delta: string;
  suppressing: boolean;
}) {
  const { criteria } = input;
  if (criteria.kind !== "artifact") {
    return false;
  }
  if (input.suppressing) {
    return true;
  }
  const combined = `${input.assistantContent}${input.delta}`.trim();
  if (looksLikeArtifactUrlLeakText(combined)) {
    return true;
  }
  if (
    criteria.artifactType === "video_presentation" &&
    criteria.toolName === AGENT_TOOL_NAMES.generateVideoPresentation
  ) {
    return looksLikeVideoPresentationSpecText(combined);
  }
  if (
    criteria.artifactType === "slides" &&
    criteria.toolName === AGENT_TOOL_NAMES.generatePptx
  ) {
    return looksLikePresentationSpecText(combined);
  }
  return false;
}

export function resolveFinalAssistantText(input: {
  assistantContent: string;
  assistantContentFromUpdates: string | null;
  commandSuccessCriteria?: CommandSuccessCriteria;
  hasCompletedToolOutput: boolean;
  allowSilentEmptyResponse?: boolean;
}) {
  const assistantContent = input.assistantContent.trim();
  if (assistantContent.length > 0) {
    if (
      input.commandSuccessCriteria &&
      shouldSuppressLeakedCommandSpecText({
        assistantContent: "",
        criteria: input.commandSuccessCriteria,
        delta: assistantContent,
        suppressing: false,
      })
    ) {
      return "";
    }
    return assistantContent;
  }

  const assistantContentFromUpdates = input.assistantContentFromUpdates?.trim();
  if (assistantContentFromUpdates && assistantContentFromUpdates.length > 0) {
    if (
      input.commandSuccessCriteria &&
      shouldSuppressLeakedCommandSpecText({
        assistantContent: "",
        criteria: input.commandSuccessCriteria,
        delta: assistantContentFromUpdates,
        suppressing: false,
      })
    ) {
      return "";
    }
    return assistantContentFromUpdates;
  }

  if (input.allowSilentEmptyResponse) {
    return "";
  }

  return input.hasCompletedToolOutput
    ? ""
    : "Model returned an empty response.";
}
