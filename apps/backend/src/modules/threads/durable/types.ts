import type {
  AgentRunStop,
  AgentRunProgress,
  MeterConsumeResponse,
} from "@sourceweft/contracts";
import type { UsageInfo } from "@sourceweft/model-gateway";
import type {
  EmbeddingVectorStrategy,
  MessageRecord,
  ThreadRecord,
} from "../../content/types";
import type { AgentCitation } from "../agent/citation-registry";
import type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
} from "../stream/types";
import type {
  AgentCheckpointMetadata,
  MeteredLlmCallTrace,
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

/** Minimal state needed for worker cancellation/ownership checks. */
export type ChatThreadRunStopState = Pick<
  ChatThreadRunRecord,
  "status" | "errorCode" | "errorMessage"
>;

/** Heartbeat acknowledgement; never transports the run's payloads. */
export type ChatThreadRunHeartbeat = ChatThreadRunStopState &
  Pick<ChatThreadRunRecord, "heartbeatAt" | "updatedAt">;

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

/**
 * The assistant message a run snapshot persists: identity, content and the
 * metadata scalars of `slimSnapshotAssistantMessage`. The messages row holds
 * the full metadata. The worker's in-memory snapshot may carry the full
 * record; persistence slims it.
 */
export type ChatRunSnapshotAssistantMessage = Pick<
  MessageRecord,
  | "id"
  | "threadId"
  | "role"
  | "parentMessageId"
  | "content"
  | "contentJson"
  | "model"
  | "createdAt"
  | "metadata"
> &
  Partial<MessageRecord> & { updatedAt?: string };

/**
 * Snapshot retrieval, in the messages-row `metadata.retrieval` shape. Profile
 * fields arrive with the finalized result; `citations` events fill the lists
 * mid-run (`citations` is then the whole registry).
 */
export type ChatRunSnapshotRetrieval = {
  embeddingProfileId?: string | null;
  vectorStrategy?: EmbeddingVectorStrategy | null;
  annIndexUsed?: string | null;
  citations: unknown[];
  availableCitations: unknown[];
};

export type ChatRunSnapshot = Omit<
  DurableRunResultSnapshot,
  "assistantMessage" | "retrieval"
> & {
  assistantMessage?: ChatRunSnapshotAssistantMessage;
  retrieval?: ChatRunSnapshotRetrieval;
  /** Captured before the first message write; reused when this run is retried. */
  reasoningRun?: import("../turn/reasoning-state").ReasoningRun;
  reasoningRevision?: number;
  /** Host-only capability receipts/idempotency state; never projected to messages. */
  protectedAgentTools?: Record<string, unknown>;
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
  /**
   * @deprecated Rows written before #333 only. The list lives on the messages
   * row (`metadata.meteredLlmCalls`); new snapshots keep only the total.
   */
  readonly meteredLlmCalls?: MeteredLlmCallTrace[];
  meteredLlmCreditsConsumed?: number;
  usage?: UsageInfo;
  /**
   * @deprecated Rows written before #333 only; read through
   * `readSnapshotRetrieval`. New snapshots keep both lists in `retrieval`.
   */
  readonly citations?: unknown[];
  /** @deprecated See `citations`. */
  readonly availableCitations?: unknown[];
  lastEventType?: string;
  finishReason?: string | null;
  agentRunStop?: AgentRunStop | null;
  agentRunProgress?: AgentRunProgress | null;
  agentCheckpoint?: AgentCheckpointMetadata | null;
  approvalRequestedAt?: string | null;
  approvalExpiresAt?: string | null;
  pendingConfirmationIds?: string[];
};
