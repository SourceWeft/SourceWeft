import type { UsageInfo } from "@sourceweft/model-gateway";
import type { AgentCitation } from "../citation-registry";
import { buildCitationMetadata } from "../../retrieval/planner";
import { contentRetrievalService } from "../../retrieval/service";
import type {
  AgentCheckpointMetadata,
  RetrievalCallTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../../threads";

export type DeepAgentTurnOutcome = {
  assistantContent: string;
  retrieval: Awaited<ReturnType<typeof contentRetrievalService.runRetrieval>> | null;
  citations: AgentCitation[];
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
  thinkingSteps: ThinkingStepTrace[];
  usage?: UsageInfo;
  finishReason?: string;
  providerFields?: Record<string, unknown>;
  agentCheckpoint: AgentCheckpointMetadata;
};

export type DeepAgentTurnEvent =
  | {
      type: "text-delta";
      delta: string;
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
      status: "completed" | "error";
      toolCall: ToolCallTrace;
    }
  | {
      type: "thinking-step";
      step: ThinkingStepTrace;
    }
  | {
      type: "citations";
      citations: ReturnType<typeof buildCitationMetadata>;
    }
  | {
      type: "done";
      outcome: DeepAgentTurnOutcome;
    };
