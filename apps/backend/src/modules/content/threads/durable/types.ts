import type { MeterConsumeResponse } from "@sourceweft/contracts";
import type { MessageRecord, ThreadRecord } from "../../types";
import type { AgentCitation } from "../../agent/citation-registry";
import type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
} from "../stream/types";
import type {
  AgentCheckpointMetadata,
  StreamThreadEventInput,
} from "../turn/types";

export type ChatThreadRunStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ChatThreadRunMode = "send" | "refresh" | "edit" | "resume";

export type ChatThreadRunRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  idempotencyKey: string;
  mode: ChatThreadRunMode;
  jobId: string | null;
  streamKey: string;
  status: ChatThreadRunStatus;
  eventOffset: number;
  requestJson: Record<string, unknown>;
  snapshotJson: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DurableRunRequestSnapshot =
  | (StreamThreadEventInput & { mode: "send" })
  | (RefreshThreadInput & { mode: "refresh" })
  | (EditThreadInput & { mode: "edit" })
  | (ResumeThreadInput & { mode: "resume" });

export type DurableRunResultSnapshot = {
  thread?: ThreadRecord;
  userMessage?: MessageRecord;
  assistantMessage?: MessageRecord;
  billing?: MeterConsumeResponse;
  retrieval?: {
    embeddingProfileId: string | null;
    vectorStrategy: "ann_hnsw" | "exact_vector" | "bm25_only" | null;
    annIndexUsed: string | null;
    citations: AgentCitation[];
    availableCitations: AgentCitation[];
  };
};

export type ChatRunSnapshot = DurableRunResultSnapshot & {
  assistantContent?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  reasoning?: string;
  reasoningSegments?: unknown[];
  toolCalls?: unknown[];
  thinkingSteps?: unknown[];
  traceEvents?: unknown[];
  traceParts?: unknown[];
  renderBlocks?: unknown[];
  citations?: unknown[];
  availableCitations?: unknown[];
  lastEventType?: string;
  finishReason?: string | null;
  agentCheckpoint?: AgentCheckpointMetadata | null;
  approvalRequestedAt?: string | null;
  approvalExpiresAt?: string | null;
  pendingConfirmationIds?: string[];
};
