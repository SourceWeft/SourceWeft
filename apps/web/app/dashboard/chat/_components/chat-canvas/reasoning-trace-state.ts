import {
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { isPendingToolConfirmation } from "@sourceweft/contracts";
import {
  formatCompactDuration,
  formatThoughtDuration,
} from "./duration-format";
import { isSandboxToolResultFailure } from "./sandbox-tool-result-display";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import type {
  ArtifactStatusSnapshot,
  ModelReasoningSegmentRecord,
  ThinkingStepRecord,
  ToolConfirmationResolution,
  ToolCallRecord,
} from "./types";
import {
  isDeliverableGenerationActive,
  isDeliverableToolName,
  resolveDeliverableElapsedMs,
  resolveDeliverableStatus,
} from "./artifact-progress";
import { resolveToolCallArtifactId } from "./artifact-work-state";

function isVisionFallbackStep(step: ThinkingStepRecord) {
  return step.metadata?.strategy === "vision_fallback";
}

export function getReasoningTraceTitle(input: {
  activeStep?: ThinkingStepRecord;
  duration?: number;
  hasRunningToolCall?: boolean;
  hasModelReasoning: boolean;
  hasTraceItems: boolean;
  isCancelled?: boolean;
  isStreaming: boolean;
  latestDisplayStep?: ThinkingStepRecord;
  reasoningDurationMs?: number;
  waitingForConfirmation?: boolean;
}) {
  if (input.isCancelled) {
    return formatThoughtDuration(input.reasoningDurationMs ?? input.duration);
  }

  if (input.waitingForConfirmation) {
    return "Thinking · Waiting for confirmation";
  }

  if (input.activeStep) {
    return `Thinking · ${input.activeStep.title}`;
  }

  if (input.hasRunningToolCall && !input.isStreaming) {
    if (
      input.latestDisplayStep &&
      input.latestDisplayStep.status !== "completed" &&
      !isVisionFallbackStep(input.latestDisplayStep)
    ) {
      return `Thinking · ${input.latestDisplayStep.title}`;
    }
    return "Thinking · Working...";
  }

  if (input.isStreaming) {
    if (
      input.latestDisplayStep &&
      input.latestDisplayStep.status !== "completed" &&
      !isVisionFallbackStep(input.latestDisplayStep)
    ) {
      return input.latestDisplayStep.title;
    }

    return "Thinking...";
  }

  if (input.hasModelReasoning) {
    return formatThoughtDuration(input.reasoningDurationMs ?? input.duration);
  }

  return input.hasTraceItems ? "Completed" : "Thinking...";
}

export function isReasoningTraceThinking(input: {
  hasActiveStep: boolean;
  hasRunningToolCall: boolean;
  hasTraceItems: boolean;
  isCancelled?: boolean;
  isStreaming: boolean;
  waitingForConfirmation?: boolean;
}) {
  if (input.isCancelled) {
    return false;
  }

  if (
    input.waitingForConfirmation ||
    input.hasActiveStep ||
    input.hasRunningToolCall
  ) {
    return true;
  }

  return input.isStreaming;
}

function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record ? record[key] : undefined;
}

function getOutputRecord(toolCall: ToolCallRecord) {
  return toolCall.output && typeof toolCall.output === "object"
    ? (toolCall.output as Record<string, unknown>)
    : undefined;
}

function formatApprovalState(state: ToolCallRecord["approvalState"]) {
  return state === "approved" || state === "rejected" ? state : null;
}

function escapeExecuteCommandForDisplay(command: string) {
  // eslint-disable-next-line no-control-regex -- escaping control chars is the point
  return command.replace(/[\x00-\x1f\x7f]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

function compactExecuteCommandForDisplay(command: string) {
  const escaped = escapeExecuteCommandForDisplay(command);
  if (escaped.length <= 240) {
    return escaped;
  }
  return `${escaped.slice(0, 237).trimEnd()}...`;
}

function getExecuteCommandDetail(toolCall: ToolCallRecord) {
  if (toolCall.tool !== "execute") {
    return null;
  }
  const command =
    toolCall.input && typeof toolCall.input === "object"
      ? (toolCall.input as Record<string, unknown>).command
      : null;
  if (typeof command !== "string" || command.trim().length === 0) {
    return null;
  }
  return `command: ${compactExecuteCommandForDisplay(command)}`;
}

function getToolHitCount(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
) {
  const outputHitCount = getRecordValue(getOutputRecord(toolCall), "hitCount");
  if (typeof outputHitCount === "number" && Number.isFinite(outputHitCount)) {
    return outputHitCount;
  }

  const metadataHitCount = getRecordValue(toolStep?.metadata, "hitCount");
  return typeof metadataHitCount === "number" &&
    Number.isFinite(metadataHitCount)
    ? metadataHitCount
    : null;
}

function getToolResultCount(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
) {
  const output = getOutputRecord(toolCall);
  const outputCount =
    getRecordValue(output, "resultCount") ?? getRecordValue(output, "urlCount");
  if (typeof outputCount === "number" && Number.isFinite(outputCount)) {
    return outputCount;
  }

  const metadataCount = getRecordValue(toolStep?.metadata, "resultCount");
  return typeof metadataCount === "number" && Number.isFinite(metadataCount)
    ? metadataCount
    : null;
}

function getConnectorResultCount(toolCall: ToolCallRecord) {
  const output = getOutputRecord(toolCall);
  const resultCount = getRecordValue(output, "resultCount");
  return typeof resultCount === "number" && Number.isFinite(resultCount)
    ? resultCount
    : null;
}

function getConnectorToolMetadata(toolCall: ToolCallRecord) {
  if (!isAgentToolDomain(toolCall.tool, "connector")) {
    return null;
  }
  if (getToolConfirmationOutput(toolCall.output)) {
    return null;
  }
  const output = getOutputRecord(toolCall);
  if (output?.type !== "connector_tool_result") {
    return null;
  }
  const toolName = getRecordValue(output, "toolName");
  const actionType = getRecordValue(output, "actionType");
  return {
    actionType:
      typeof actionType === "string" && actionType.trim()
        ? actionType.trim()
        : null,
    toolName:
      typeof toolName === "string" && toolName.trim()
        ? toolName.trim()
        : toolCall.tool,
  };
}

export function getConnectorToolDisplayLabel(
  toolCall: ToolCallRecord,
): string | null {
  const connectorMetadata = getConnectorToolMetadata(toolCall);
  if (!connectorMetadata) {
    return null;
  }

  const toolName = formatToolName(connectorMetadata.toolName);
  if (toolCall.status === "error") {
    return `${toolName} failed`;
  }
  if (
    toolCall.status === "running" ||
    toolCall.status === "approval_requested"
  ) {
    return `Running ${toolName}`;
  }
  return `${toolName} completed`;
}

function getToolFetchUrls(toolCall: ToolCallRecord) {
  const items = getRecordValue(toolCall.input, "items");
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const url = (item as Record<string, unknown>).url;
      return typeof url === "string" && url.trim().length > 0
        ? url.trim()
        : null;
    })
    .filter((url): url is string => url !== null);
}

function getToolFetchCount(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
) {
  const urls = getToolFetchUrls(toolCall);
  if (urls.length > 0) {
    return urls.length;
  }

  const metadataUrlCount = getRecordValue(toolStep?.metadata, "urlCount");
  return typeof metadataUrlCount === "number" &&
    Number.isFinite(metadataUrlCount)
    ? metadataUrlCount
    : null;
}

function getToolConcurrency(toolStep?: ThinkingStepRecord) {
  const concurrency = getRecordValue(toolStep?.metadata, "concurrency");
  return typeof concurrency === "number" && Number.isFinite(concurrency)
    ? concurrency
    : null;
}

function getGeneratedImageStage(toolCall: ToolCallRecord) {
  const stage = getRecordValue(getOutputRecord(toolCall), "stage");
  return typeof stage === "string" && stage.trim().length > 0
    ? stage.trim()
    : null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatToolName(toolName: string) {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function getResolvedToolConfirmationMessage(input: {
  confirmation: ReturnType<typeof getToolConfirmationOutput>;
  confirmationResolution?: ToolConfirmationResolution | null;
}) {
  if (!input.confirmation) {
    return null;
  }
  if (input.confirmationResolution?.expired) {
    return "Approval expired without a decision. The action was not run.";
  }
  if (input.confirmationResolution?.stopped) {
    return "Approval stopped. The action was not run.";
  }
  if (input.confirmationResolution?.decision === "reject") {
    return "Approval rejected. The action was not run.";
  }
  if (input.confirmationResolution?.decision === "approve") {
    return "Approval recorded. Waiting for the run to continue.";
  }

  switch (input.confirmation.status) {
    case "approved":
      return "Approval recorded. The action may now run.";
    case "rejected":
    case "canceled":
      return "Approval rejected. The action was not run.";
    case "failed":
      return "Approval failed. The action was not run.";
    case "running":
      return "Approval recorded. The action is running.";
    case "succeeded":
      return "Approval recorded. The action completed.";
    case "proposed":
    default:
      return null;
  }
}

export function isToolConfirmationResolved(input: {
  confirmation: ReturnType<typeof getToolConfirmationOutput>;
  confirmationResolution?: ToolConfirmationResolution | null;
}) {
  return Boolean(
    input.confirmation &&
    (input.confirmationResolution ||
      !isPendingToolConfirmation(input.confirmation)),
  );
}

export function getToolApprovalDisplayLabel(
  toolCall: ToolCallRecord,
  confirmationResolution?: ToolConfirmationResolution | null,
) {
  const confirmation = getToolConfirmationOutput(toolCall.output);
  if (confirmation) {
    const toolName = formatToolName(toolCall.tool);
    if (toolCall.status === "error") {
      return `${toolName} approval failed`;
    }
    if (confirmationResolution?.expired) {
      return `${toolName} approval expired`;
    }
    if (confirmationResolution?.stopped) {
      return `${toolName} approval stopped`;
    }
    if (confirmationResolution?.decision === "reject") {
      return `${toolName} approval rejected`;
    }
    if (
      confirmationResolution?.decision === "approve" ||
      confirmation.status === "approved" ||
      confirmation.status === "running" ||
      confirmation.status === "succeeded"
    ) {
      return `${toolName} approval recorded`;
    }
    if (isPendingToolConfirmation(confirmation)) {
      return `${toolName} waiting for approval`;
    }
    if (
      confirmation.status === "rejected" ||
      confirmation.status === "canceled"
    ) {
      return `${toolName} approval rejected`;
    }
    if (confirmation.status === "failed") {
      return `${toolName} approval failed`;
    }
    return `${toolName} approval recorded`;
  }

  if (toolCall.approvalState === "approved" && toolCall.status === "error") {
    return `${formatToolName(toolCall.tool)} approved action failed`;
  }

  return null;
}

export function getToolCallDetailParts(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
  confirmationResolution?: ToolConfirmationResolution | null,
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>,
) {
  const hitCount = getToolHitCount(toolCall, toolStep);
  const resultCount = hasAgentToolCapability(toolCall.tool, "web_query")
    ? getToolResultCount(toolCall, toolStep)
    : isAgentToolDomain(toolCall.tool, "connector")
      ? getConnectorResultCount(toolCall)
      : null;
  const fetchCount = hasAgentToolCapability(toolCall.tool, "web_page_fetch")
    ? getToolFetchCount(toolCall, toolStep)
    : null;
  const concurrency = hasAgentToolCapability(toolCall.tool, "web_page_fetch")
    ? getToolConcurrency(toolStep)
    : null;
  const artifactIdForTiming = isDeliverableToolName(toolCall.tool)
    ? resolveToolCallArtifactId(toolCall.output)
    : undefined;
  const deliverableElapsedMs = artifactIdForTiming
    ? resolveDeliverableElapsedMs({
        artifactSnapshot: artifactStatuses?.get(artifactIdForTiming),
        toolCallOutput: toolCall.output,
        toolName: toolCall.tool,
      })
    : null;
  const latencyMs = isDeliverableToolName(toolCall.tool)
    ? deliverableElapsedMs
    : (toolCall.latencyMs ??
      (typeof toolStep?.metadata?.latencyMs === "number"
        ? toolStep.metadata.latencyMs
        : null));
  const imageStage = hasAgentToolCapability(
    toolCall.tool,
    "generated_image_artifact",
  )
    ? getGeneratedImageStage(toolCall)
    : null;
  const confirmation = getToolConfirmationOutput(toolCall.output);
  const connectorMetadata = getConnectorToolMetadata(toolCall);
  let statusLabel: string = toolCall.status;
  if (confirmationResolution?.expired) {
    statusLabel = "approval expired";
  } else if (confirmationResolution?.stopped) {
    statusLabel = "approval stopped";
  } else if (confirmationResolution?.decision === "reject") {
    statusLabel = "approval rejected";
  } else if (confirmationResolution?.decision === "approve") {
    statusLabel = "approval recorded";
  } else if (confirmation) {
    if (
      confirmation.status === "approved" ||
      confirmation.status === "running" ||
      confirmation.status === "succeeded"
    ) {
      statusLabel = "approval recorded";
    } else if (
      confirmation.status === "rejected" ||
      confirmation.status === "canceled"
    ) {
      statusLabel = "approval rejected";
    } else if (confirmation.status === "failed") {
      statusLabel = "approval failed";
    } else if (toolCall.status === "approval_requested") {
      statusLabel = "waiting for approval";
    }
  } else if (
    toolCall.approvalState === "approved" &&
    toolCall.status === "error"
  ) {
    statusLabel = "approved action failed";
  } else if (toolCall.approvalState === "rejected") {
    statusLabel = "approval rejected";
  } else if (
    isSandboxToolResultFailure({
      output: toolCall.output,
      toolName: toolCall.tool,
    })
  ) {
    statusLabel = "error";
  } else if (isDeliverableToolName(toolCall.tool)) {
    const artifactId = resolveToolCallArtifactId(toolCall.output);
    const artifactSnapshot = artifactId
      ? artifactStatuses?.get(artifactId)
      : undefined;
    const generationStatus = resolveDeliverableStatus({
      artifactSnapshot,
      toolCallOutput: toolCall.output,
      toolCallStatus: toolCall.status,
      toolName: toolCall.tool,
    });
    if (
      isDeliverableGenerationActive({
        artifactSnapshot,
        toolCallOutput: toolCall.output,
        toolCallStatus: toolCall.status,
        toolName: toolCall.tool,
      })
    ) {
      statusLabel = "generating";
    } else if (generationStatus === "failed") {
      statusLabel = "failed";
    } else if (generationStatus === "ready") {
      statusLabel = "completed";
    }
  }
  const approvalState = formatApprovalState(toolCall.approvalState);
  const executeCommandDetail = getExecuteCommandDetail(toolCall);
  return [
    `status: ${statusLabel}`,
    executeCommandDetail,
    approvalState ? `approval: ${approvalState}` : null,
    toolCall.approvalConfirmationId
      ? `confirmation: ${toolCall.approvalConfirmationId}`
      : null,
    connectorMetadata?.toolName ? `tool: ${connectorMetadata.toolName}` : null,
    connectorMetadata?.actionType
      ? `action: ${connectorMetadata.actionType}`
      : null,
    imageStage ? `stage: ${imageStage}` : null,
    hitCount !== null ? `hits: ${hitCount}` : null,
    resultCount !== null
      ? `${resultCount} ${pluralize(resultCount, "result")}`
      : null,
    fetchCount !== null
      ? `${fetchCount} ${pluralize(fetchCount, "URL")}`
      : null,
    concurrency !== null ? `concurrency: ${concurrency}` : null,
    typeof latencyMs === "number"
      ? isDeliverableToolName(toolCall.tool)
        ? `time: ${formatCompactDuration(latencyMs)}`
        : `time: ${Math.round(latencyMs)}ms`
      : null,
  ].filter((part): part is string => part !== null);
}

export type ReasoningTraceTimelineItem =
  | {
      kind: "model-reasoning";
      key: string;
      originalIndex: number;
      phase?: ModelReasoningSegmentRecord["phase"];
      sequence: number;
      text: string;
      toolCallId?: ModelReasoningSegmentRecord["toolCallId"];
      durationMs?: number;
    }
  | {
      kind: "step";
      key: string;
      originalIndex: number;
      sequence: number;
      step: ThinkingStepRecord;
    }
  | {
      kind: "tool";
      key: string;
      originalIndex: number;
      sequence: number;
      toolCall: ToolCallRecord;
      toolStep?: ThinkingStepRecord;
    };

const TIMELINE_KIND_PRIORITY: Record<
  ReasoningTraceTimelineItem["kind"],
  number
> = {
  "model-reasoning": 0,
  step: 1,
  tool: 2,
};

export function compareReasoningTraceTimelineItems(
  left: ReasoningTraceTimelineItem,
  right: ReasoningTraceTimelineItem,
) {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  const priorityDelta =
    TIMELINE_KIND_PRIORITY[left.kind] - TIMELINE_KIND_PRIORITY[right.kind];
  return priorityDelta === 0
    ? left.originalIndex - right.originalIndex
    : priorityDelta;
}
