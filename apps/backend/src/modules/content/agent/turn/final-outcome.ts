import type { createThreadAgent } from "..";
import type { AgentCheckpointRef, PreparedThreadTurn } from "../../threads";
import { finalizeMessageRenderBlocks } from "../../threads/turn/render-blocks";
import {
  checkpointRefFromConfig,
  getAgentStateOrNull,
  type AgentRunnableConfig,
} from "./checkpoint";
import {
  commandSuccessFailureText,
  isCommandSuccessSatisfied,
  resolveFinalAssistantText,
} from "./command-success";
import { sanitizeSseValue } from "./content";
import {
  buildCitationVerificationStep,
  normalizeAssistantTextCitations,
} from "./citation-tracker";
import type { DeepAgentTurnEvent } from "./events";
import { shouldSilenceEmptyApprovalResume } from "./hitl-handler";
import { compactTraceText } from "./output-normalizer";
import {
  extractReasoningSummaryFromProviderFields,
  listThinkingSteps,
} from "./thinking";
import type { TurnRuntime } from "./turn-runtime";

type Agent = Awaited<ReturnType<typeof createThreadAgent>>;

export async function* buildFinalOutcome(input: {
  agent: Agent;
  beforeAssistantCheckpoint: AgentCheckpointRef | null;
  beforeInputCheckpoint: AgentCheckpointRef | null;
  finalCheckpoint: AgentCheckpointRef | null;
  prepared: PreparedThreadTurn;
  runConfig: AgentRunnableConfig;
  runtime: TurnRuntime;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { runtime } = input;
  const hasCompletedToolOutput = runtime.collectToolCalls().some(
    (call) => call.status === "completed" && !call.error,
  );
  let assistantText = resolveFinalAssistantText({
    assistantContent: runtime.assistantContent,
    assistantContentFromUpdates: runtime.assistantContentFromUpdates,
    commandSuccessCriteria: input.prepared.commandSuccessCriteria,
    hasCompletedToolOutput,
    allowSilentEmptyResponse: shouldSilenceEmptyApprovalResume({
      assistantMessageId: input.prepared.assistantMessageId,
      hasCompletedToolOutput,
      toolApprovalResume: input.prepared.toolApprovalResume,
    }),
  });

  const finalRetrieval = runtime.latestToolRetrieval;
  const finalCitations = runtime.citationRegistry.list();
  const reasoningSummary = extractReasoningSummaryFromProviderFields(
    runtime.providerFields,
  );

  if (reasoningSummary) {
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep({
        id: "reasoning-summary",
        kind: "reasoning_summary",
        title: "Reasoning summary",
        status: "completed",
        items: [],
        description: compactTraceText(reasoningSummary, 280),
      }),
    };
  }

  yield {
    type: "thinking-step",
    step: runtime.setThinkingStep({
      id: "verify",
      kind: "verification",
      title: "Checking citations",
      status: "in_progress",
      items: [],
      description: "Normalizing citation markers before saving the answer.",
    }),
  };

  const citationNormalization = normalizeAssistantTextCitations({
    assistantText,
    citations: finalCitations,
  });
  assistantText = citationNormalization.text;
  const usedCitations = citationNormalization.citations;

  yield {
    type: "thinking-step",
    step: runtime.setThinkingStep(
      buildCitationVerificationStep({
        normalization: citationNormalization,
        availableCitationCount: finalCitations.length,
      }),
    ),
  };

  yield {
    type: "citations",
    citations: usedCitations,
    availableCitations: finalCitations,
  };

  if (!runtime.hasStreamedText && assistantText.length > 0) {
    runtime.renderBlocks.appendText(assistantText);
    yield {
      type: "text-delta",
      delta: sanitizeSseValue(assistantText),
    };
  }

  const retrievalCalls = runtime.collectRetrievalCalls();
  const toolCalls = runtime.collectToolCalls();
  const commandSatisfied = isCommandSuccessSatisfied({
    criteria: input.prepared.commandSuccessCriteria,
    toolCalls,
  });
  if (!commandSatisfied) {
    const criteria = input.prepared.commandSuccessCriteria;
    const errorText = commandSuccessFailureText(criteria, toolCalls);
    assistantText = errorText;
    runtime.assistantContent = errorText;
    runtime.finishReason = "command_success_criteria_failed";
    if (runtime.hasStreamedText) {
      runtime.renderBlocks.replaceText(errorText);
      yield {
        type: "text-replace",
        text: sanitizeSseValue(errorText),
      };
    } else {
      runtime.renderBlocks.appendText(errorText);
      yield {
        type: "text-delta",
        delta: sanitizeSseValue(errorText),
      };
    }
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep({
        id: "command-success",
        kind: "verification",
        title: "Checking command outcome",
        status: "completed",
        items: [],
        description: errorText,
        metadata: {
          criteria,
        },
      }),
    };
  }

  let finalCheckpoint = input.finalCheckpoint;
  const finalState = finalCheckpoint
    ? null
    : await getAgentStateOrNull(input.agent, input.runConfig);
  finalCheckpoint ??= checkpointRefFromConfig(
    (finalState as { config?: unknown } | null)?.config,
  );
  const finalRenderBlocks = finalizeMessageRenderBlocks({
    blocks: runtime.renderBlocks.list(),
    finalText: assistantText,
  });

  yield {
    type: "done",
    outcome: {
      assistantContent: assistantText,
      usage: runtime.usage,
      finishReason: runtime.finishReason,
      reasoning: runtime.modelReasoning,
      retrieval: finalRetrieval,
      citations: usedCitations,
      availableCitations: finalCitations,
      retrievalCalls,
      toolCalls,
      ...(finalRenderBlocks.length > 0
        ? { renderBlocks: finalRenderBlocks }
        : {}),
      thinkingSteps: listThinkingSteps({
        stepsById: runtime.thinkingStepsById,
        stepOrder: runtime.thinkingStepOrder,
      }),
      reasoningSegments: runtime.reasoningSegments,
      agentCheckpoint: {
        beforeInput: input.beforeInputCheckpoint,
        beforeAssistant: input.beforeAssistantCheckpoint,
        resume: null,
        final: finalCheckpoint,
      },
    },
  };
}
