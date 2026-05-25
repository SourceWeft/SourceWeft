import type { UsageInfo } from "@sourceweft/model-gateway";
import type { AgentCitation } from "../citation-registry";
import { contentRetrievalService } from "../../retrieval/service";
import type {
  AgentCheckpointMetadata,
  MessageRenderBlock,
  RetrievalCallTrace,
  ModelReasoningSegmentTrace,
  ThinkingStepTrace,
  ToolCallTrace,
  ToolCallStatus,
  TracePart,
} from "../../threads";

export type DeepAgentTurnOutcome = {
  assistantContent: string;
  retrieval: Awaited<
    ReturnType<typeof contentRetrievalService.runRetrieval>
  > | null;
  citations: AgentCitation[];
  availableCitations: AgentCitation[];
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
  thinkingSteps: ThinkingStepTrace[];
  renderBlocks?: MessageRenderBlock[];
  reasoningSegments: ModelReasoningSegmentTrace[];
  traceParts?: TracePart[];
  usage?: UsageInfo;
  finishReason?: string;
  reasoning?: string;
  agentCheckpoint: AgentCheckpointMetadata;
};

export type DeepAgentTurnEvent =
  | {
      type: "text-delta";
      delta: string;
    }
  | {
      type: "text-replace";
      text: string;
    }
  | {
      type: "text-interrupted";
      reason: "tool-call";
      toolCallId: string;
      tool: string;
    }
  | {
      type: "tool-call-start";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      toolCall: ToolCallTrace;
    }
  | {
      type: "tool-call-event";
      id: string;
      tool: string;
      data: unknown;
      toolCall: ToolCallTrace;
    }
  | {
      type: "tool-call-result";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      latencyMs: number | null;
      toolCall: ToolCallTrace;
      query?: string;
      hitCount?: number;
    }
  | {
      type: "tool-call-error";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      error: string;
      latencyMs: number | null;
      toolCall: ToolCallTrace;
    }
  | {
      type: "tool-call-end";
      id: string;
      tool: string;
      latencyMs: number | null;
      status: Exclude<ToolCallStatus, "running">;
      toolCall: ToolCallTrace;
    }
  | {
      type: "thinking-step";
      step: ThinkingStepTrace;
    }
  | {
      type: "citations";
      citations: AgentCitation[];
      availableCitations?: AgentCitation[];
    }
  | {
      type: "reasoning";
      reasoning: string;
      segment: ModelReasoningSegmentTrace;
    }
  | {
      type: "done";
      outcome: DeepAgentTurnOutcome;
    };
