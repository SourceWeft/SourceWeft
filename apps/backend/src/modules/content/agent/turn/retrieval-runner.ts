import type { TraceContext } from "../../../../shared/llm-observability";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import { contentRetrievalService } from "../../retrieval/service";
import type { PreparedThreadTurn } from "../../threads";

export async function runToolRetrieval(input: {
  prepared: PreparedThreadTurn;
  query: string;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
}) {
  return contentRetrievalService.runRetrieval({
    workspaceId: input.prepared.workspace.id,
    teamId: input.prepared.workspace.organizationId,
    threadId: input.prepared.thread.id,
    userId: input.prepared.userId,
    userMessageId: input.prepared.userMessage.id,
    queryText: input.query,
    anchorSourceIds: input.prepared.effectiveMentionedSourceIds,
    sourceIds: input.prepared.sourceIds,
    idempotencyKey: input.prepared.llmIdempotencyKey,
    llm: input.llm,
    traceContext: input.traceContext,
  });
}
