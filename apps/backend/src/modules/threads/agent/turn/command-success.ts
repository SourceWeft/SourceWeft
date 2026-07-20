import type { CommandExecutionPolicy } from "..";
import type {
  CommandSuccessCriteria,
  PreparedThreadTurn,
  ToolCallTrace,
} from "../..";
import {
  hasAgentToolCapability,
  isArtifactProgressProcessingOutputType,
  isArtifactProgressResultOutputType,
  isArtifactProgressTerminalOutputType,
} from "@sourceweft/agent-tool-registry";
import { extractToolOutputField } from "./output-normalizer";
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
          // A background deliverable satisfies the criteria once the job is
          // running (accepted for processing) or once it finished ready — a
          // terminal record with any other status is a failure, not a success.
          const outputType = extractToolOutputField(call.output, "type");
          return Boolean(
            extractToolOutputField(call.output, "artifact_id") &&
              extractToolOutputField(call.output, "artifact_url") &&
              extractToolOutputField(call.output, "job_id") &&
              (isArtifactProgressProcessingOutputType(outputType) ||
                (isArtifactProgressTerminalOutputType(outputType) &&
                  extractToolOutputField(call.output, "status") === "ready")),
          );
        }
        if (criteria.artifactType !== "image") {
          return true;
        }
        return Boolean(
          extractToolOutputField(call.output, "artifact_id") &&
            extractToolOutputField(call.output, "artifact_url"),
        );
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
    case "artifact": {
      const matchingToolCalls = toolCalls.filter(
        (call) => call.tool === criteria.toolName,
      );
      const latestToolMessage = latestToolFailureMessage(matchingToolCalls);
      if (matchingToolCalls.length > 0) {
        if (latestToolMessage) {
          return `Command failed because ${criteria.toolName} reported: ${latestToolMessage}`;
        }
        return `Command failed because ${criteria.toolName} did not create a ${criteria.artifactType} artifact.`;
      }
      return `Command failed because ${criteria.toolName} was not called to create a ${criteria.artifactType} artifact.`;
    }
    case "tool_call": {
      const matchingToolCalls = toolCalls.filter(
        (call) => call.tool === criteria.toolName,
      );
      const latestToolMessage = latestToolFailureMessage(matchingToolCalls);
      if (matchingToolCalls.length > 0) {
        if (latestToolMessage) {
          return `Command failed because ${criteria.toolName} reported: ${latestToolMessage}`;
        }
        return `Command failed because ${criteria.toolName} did not complete successfully.`;
      }
      return `Command failed because ${criteria.toolName} was not called.`;
    }
  }
}

function latestToolFailureMessage(toolCalls: ToolCallTrace[]) {
  return [...toolCalls]
    .reverse()
    .map(
      (call) =>
        extractToolOutputField(call.output, "message") ??
        extractToolOutputField(call.output, "error") ??
        call.error,
    )
    .find((message): message is string => Boolean(message));
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
  if (prepared.command?.kind !== "tool") {
    return undefined;
  }
  return {
    targetToolName: criteria.toolName,
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
    criteria.artifactType === "slides" &&
    hasAgentToolCapability(criteria.toolName, "presentation_artifact")
  ) {
    // Presentation artifact publishers are lightweight publication tools.
    // Success means the tool was called and returned a valid artifact.
    try {
      const parsed = JSON.parse(combined);
      return Boolean(
        parsed &&
          typeof parsed === "object" &&
          parsed.ok === true &&
          parsed.artifactId,
      );
    } catch {
      return false;
    }
  }
  return false;
}

function resolveToolOnlyAssistantText(toolCalls: ToolCallTrace[]) {
  for (const call of [...toolCalls].reverse()) {
    if (call.status !== "completed" || call.error) {
      continue;
    }
    // Only a result record carries user-facing prose worth promoting to the
    // assistant turn; a progress tick reports no outcome to speak of.
    const outputType = extractToolOutputField(call.output, "type");
    if (!isArtifactProgressResultOutputType(outputType)) {
      continue;
    }
    const content = extractToolOutputField(call.output, "content");
    if (content && content.trim().length > 0) {
      return content.trim();
    }
  }
  return "";
}

export function resolveFinalAssistantText(input: {
  assistantContent: string;
  assistantContentFromUpdates: string | null;
  commandSuccessCriteria?: CommandSuccessCriteria;
  hasCompletedToolOutput: boolean;
  allowSilentEmptyResponse?: boolean;
  toolCalls?: ToolCallTrace[];
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

  if (input.hasCompletedToolOutput && input.toolCalls?.length) {
    const toolText = resolveToolOnlyAssistantText(input.toolCalls);
    if (toolText.length > 0) {
      return toolText;
    }
  }

  return input.hasCompletedToolOutput
    ? ""
    : "Model returned an empty response.";
}
