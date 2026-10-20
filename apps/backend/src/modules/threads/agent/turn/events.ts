import type { AgentRunStop, AgentRunProgress } from "@sourceweft/contracts";
import type { UsageInfo } from "@sourceweft/model-gateway";
import type { AgentCitation } from "../citation-registry";
import { runToolRetrieval } from "./retrieval-runner";
import type {
  AgentCheckpointMetadata,
  MessageRenderBlock,
  RetrievalCallTrace,
  ModelReasoningSegmentTrace,
  ThinkingStepTrace,
  ToolCallTrace,
  ToolCallStatus,
  TracePart,
} from "../..";
import type { MeteredLlmCallTrace } from "../../turn/types";

export type DeepAgentTurnOutcome = {
  assistantContent: string;
  retrieval: Awaited<ReturnType<typeof runToolRetrieval>> | null;
  citations: AgentCitation[];
  availableCitations: AgentCitation[];
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
  meteredLlmCalls?: MeteredLlmCallTrace[];
  thinkingSteps: ThinkingStepTrace[];
  renderBlocks?: MessageRenderBlock[];
  reasoningSegments: ModelReasoningSegmentTrace[];
  traceParts?: TracePart[];
  usage?: UsageInfo;
  finishReason?: string;
  agentRunStop?: AgentRunStop;
  agentRunProgress?: AgentRunProgress;
  reasoning?: string;
  agentCheckpoint: AgentCheckpointMetadata;
};

export type DeepAgentTurnEvent =
  | { type: "agent-run-progress"; progress: AgentRunProgress }
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
      // Incremental tool-call arguments streamed while the model is still
      // generating the call (today: write_file `content`), so the client can
      // render the code as it's authored. Additive: the authoritative
      // fully-formed call still arrives later via `tool-call-start` (same id).
      type: "tool-input-delta";
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
      // A model-call attempt died mid-stream and the retry middleware is about
      // to replay the call (`attempt` is the attempt that starts next; 2 for
      // the first retry). Everything the failed attempt streamed is withdrawn:
      // `segmentIds` are its reasoning segments, `toolCallIds` the tool calls
      // whose argument chunks it streamed but never completed. The text and
      // unbounded reasoning the attempt streamed are described twice: as the
      // this-run lengths that survive (`keep*Chars`) and as the tail lengths
      // to cut (`drop*Chars`) — the latter is what a client whose buffer
      // starts with a prior run's text (a resumed turn) must apply. The
      // retried attempt then streams under fresh segment ids.
      type: "segment-reset";
      reason: "model_call_retry";
      attempt: number;
      segmentIds: string[];
      toolCallIds: string[];
      keepTextChars: number;
      keepReasoningChars: number;
      dropTextChars: number;
      dropReasoningChars: number;
    }
  | {
      type: "done";
      outcome: DeepAgentTurnOutcome;
    };
