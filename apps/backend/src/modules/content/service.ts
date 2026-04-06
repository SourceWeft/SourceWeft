import { LiteLLMError, type UsageInfo } from "@sourceweft/litellm-sdk";
import {
  createCitationRecords,
  createMessageRecord,
  createRetrievalHits,
  createRetrievalRun,
  createSourceRecord,
  createThreadRecord,
  deleteSourceRecord,
  findDefaultEmbeddingProfile,
  findSourceRecord,
  findThreadRecord,
  getSourceDetailRecord,
  listSourceRecords,
  listThreadSourceIds,
  listThreadSourceRecords,
  replaceSourceDocumentsAndEmbeddings,
  replaceThreadSourceRecords,
  searchChunksByBm25,
  searchChunksByVectorAnn,
  searchChunksByVectorExact,
  updateSourceRecord,
  updateSourceStatus,
} from "./store";
import { ContentError } from "./errors";
import { workspaceService } from "../workspace";
import { billingService } from "../billing";
import { config } from "../../shared/config";
import { litellm } from "../../shared/litellm";
import type {
  EmbeddingProfileRecord,
  EmbeddingVectorStrategy,
  SourceRecord,
} from "./types";

const DEFAULT_MODEL_ALIAS = "chat-default";
const DEFAULT_RRF_K = 60;
const DEFAULT_VECTOR_TOP_K = 8;
const DEFAULT_BM25_TOP_K = 12;
const MAX_VECTOR_PREFILTER = 24;

type RetrievalCandidate = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  stage: "bm25" | "vector";
};

type ThreadSourceResponseItem = {
  source: SourceRecord;
  selectedAt: string;
  selectedBy: string | null;
};

type RetrievalPlannerResult = {
  strategy: EmbeddingVectorStrategy;
  annIndexUsed: string | null;
  requestedDimensions: number | null;
};

function normalizeTitle(value: string | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 200);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateProviderCostUsd(input: {
  userContent: string;
  assistantContent: string;
  usage?: UsageInfo;
}) {
  const usage = input.usage;
  const inputTokens = usage?.inputTokens ?? estimateTokens(input.userContent);
  const outputTokens =
    usage?.outputTokens ?? estimateTokens(input.assistantContent);
  const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;

  const usd = totalTokens * 0.000002;
  return Number(usd.toFixed(6));
}

function toContentServiceError(error: unknown): ContentError {
  if (!LiteLLMError.isInstance(error)) {
    return new ContentError(502, "MODEL_UPSTREAM_ERROR", "LLM request failed");
  }

  const litellmError = error as LiteLLMError;

  if (litellmError.code === "BAD_REQUEST") {
    return new ContentError(400, "MODEL_REQUEST_INVALID", litellmError.message);
  }

  if (litellmError.code === "RATE_LIMIT") {
    return new ContentError(
      429,
      "MODEL_RATE_LIMITED",
      "LLM provider rate limit reached",
    );
  }

  if (litellmError.code === "TIMEOUT") {
    return new ContentError(504, "MODEL_TIMEOUT", "LLM request timed out");
  }

  if (litellmError.code === "AUTH") {
    return new ContentError(
      502,
      "MODEL_GATEWAY_AUTH_ERROR",
      "LiteLLM gateway authentication failed",
    );
  }

  return new ContentError(502, "MODEL_UPSTREAM_ERROR", litellmError.message);
}

function resolveAssistantContent(input: {
  outputText: string;
  toolCalls?: Array<{ name: string; argsJson?: string }>;
}) {
  const text = input.outputText.trim();
  if (text.length > 0) {
    return text;
  }

  if (input.toolCalls && input.toolCalls.length > 0) {
    return input.toolCalls
      .map((toolCall) => `${toolCall.name}: ${toolCall.argsJson ?? "{}"}`)
      .join("\n");
  }

  return "Model returned an empty response.";
}

function cosineSimilarity(left: number[], right: number[]) {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function reciprocalRankFusion(
  vectorCandidates: RetrievalCandidate[],
  bm25Candidates: RetrievalCandidate[],
  limit: number,
) {
  const scores = new Map<
    string,
    RetrievalCandidate & { rrfScore: number; stages: Set<"bm25" | "vector"> }
  >();

  const accumulate = (candidates: RetrievalCandidate[]) => {
    candidates.forEach((candidate, index) => {
      const rankScore = 1 / (DEFAULT_RRF_K + index + 1);
      const existing = scores.get(candidate.chunkId);
      if (existing) {
        existing.rrfScore += rankScore;
        existing.stages.add(candidate.stage);
        existing.score = Math.max(existing.score, candidate.score);
        return;
      }

      scores.set(candidate.chunkId, {
        ...candidate,
        rrfScore: rankScore,
        stages: new Set([candidate.stage]),
      });
    });
  };

  accumulate(vectorCandidates);
  accumulate(bm25Candidates);

  return [...scores.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore)
    .slice(0, limit)
    .map((candidate) => ({
      ...candidate,
      stages: [...candidate.stages],
    }));
}

function inferHeadingPath(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[0] ?? null;
}

function chunkSourceContent(contentText: string) {
  const normalized = contentText.trim();
  if (!normalized) {
    return [] as Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      chunkNo: number;
      headingPath: string | null;
    }>;
  }

  const maxChars = 1200;
  const overlap = 200;
  const chunks: Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    chunkNo: number;
    headingPath: string | null;
  }> = [];

  let start = 0;
  let chunkNo = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const newlineIndex = normalized.lastIndexOf("\n", end);
      const sentenceIndex = Math.max(
        normalized.lastIndexOf(". ", end),
        normalized.lastIndexOf("。", end),
      );
      const boundary = Math.max(newlineIndex, sentenceIndex);
      if (boundary > start + 300) {
        end = boundary + 1;
      }
    }

    const content = normalized.slice(start, end).trim();
    if (content) {
      chunks.push({
        content,
        startOffset: start,
        endOffset: end,
        chunkNo,
        headingPath: inferHeadingPath(content),
      });
      chunkNo += 1;
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(0, end - overlap);
  }

  return chunks;
}

function planRetrievalStrategy(
  profile: EmbeddingProfileRecord,
): RetrievalPlannerResult {
  const dimensions = profile.requestedDimensions ?? null;
  if (profile.vectorStrategy === "disabled") {
    return {
      strategy: "bm25_only",
      annIndexUsed: null,
      requestedDimensions: dimensions,
    };
  }

  if (profile.vectorStrategy === "exact") {
    return {
      strategy: "exact_vector",
      annIndexUsed: null,
      requestedDimensions: dimensions,
    };
  }

  if (dimensions && dimensions <= 2000) {
    return {
      strategy: "ann_hnsw",
      annIndexUsed: `${profile.id}_${dimensions}_hnsw`,
      requestedDimensions: dimensions,
    };
  }

  return {
    strategy:
      dimensions && dimensions > 2000 ? "bm25_prefilter_exact" : "exact_vector",
    annIndexUsed: null,
    requestedDimensions: dimensions,
  };
}

async function requireWorkspace(input: {
  workspaceId: string;
  userId: string;
}) {
  const workspace = await workspaceService.resolveWorkspace(input);
  if (!workspace) {
    throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  }

  return workspace;
}

async function requireSource(input: {
  workspaceId: string;
  userId: string;
  sourceId: string;
}) {
  const workspace = await requireWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  const source = await findSourceRecord({
    sourceId: input.sourceId,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });

  if (!source) {
    throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
  }

  return {
    workspace,
    source,
  };
}

async function requireDefaultEmbeddingProfile() {
  const profile = await findDefaultEmbeddingProfile();
  if (!profile) {
    throw new ContentError(
      500,
      "EMBEDDING_PROFILE_NOT_CONFIGURED",
      "Default embedding profile is not configured",
    );
  }

  return profile;
}

function tokenizeForBm25(text: string) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function buildCitationMetadata(candidates: RetrievalCandidate[]) {
  return candidates.map((candidate, index) => ({
    citation: index + 1,
    sourceId: candidate.sourceId,
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    score: Number(candidate.score.toFixed(6)),
    excerpt: candidate.content.slice(0, 240),
  }));
}

async function rerankCandidates(input: {
  queryText: string;
  candidates: RetrievalCandidate[];
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
}) {
  if (input.candidates.length <= 1) {
    return input.candidates;
  }

  const rerankResult = await litellm.rerank
    .rank({
      model: config.litellm.rerankModelAlias,
      query: input.queryText,
      documents: input.candidates.map((candidate) => candidate.content),
      topN: Math.min(input.candidates.length, 6),
      returnDocuments: false,
      metadata: {
        team_id: input.teamId,
        workspace_id: input.workspaceId,
        user_id: input.userId,
        thread_id: input.threadId,
        feature: "retrieval_rerank",
      },
    })
    .catch((error: unknown) => {
      throw toContentServiceError(error);
    });

  return rerankResult.results
    .map((item) => {
      const candidate = input.candidates[item.index];
      if (!candidate) {
        return null;
      }
      return {
        ...candidate,
        score: item.relevanceScore,
      };
    })
    .filter((candidate): candidate is RetrievalCandidate => candidate !== null);
}

async function resolveThreadSourceItems(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const records = await listThreadSourceRecords({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  });

  const items: ThreadSourceResponseItem[] = [];
  for (const record of records) {
    const source = await findSourceRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: record.sourceId,
    });
    if (!source) {
      continue;
    }

    items.push({
      source,
      selectedAt: record.createdAt,
      selectedBy: record.selectedBy,
    });
  }

  return items;
}

async function runRetrieval(input: {
  workspaceId: string;
  teamId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  queryText: string;
  idempotencyKey?: string;
}) {
  const profile = await requireDefaultEmbeddingProfile();
  const planner = planRetrievalStrategy(profile);
  const threadSourceIds = await listThreadSourceIds({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  });

  const startedAt = Date.now();
  let queryEmbedding: number[] = [];
  if (planner.strategy !== "bm25_only") {
    const embedResult = await litellm.embeddings
      .embed(
        {
          model: profile.providerModelAlias,
          text: input.queryText,
          dimensions: planner.requestedDimensions ?? undefined,
          metadata: {
            team_id: input.teamId,
            workspace_id: input.workspaceId,
            user_id: input.userId,
            thread_id: input.threadId,
            feature: "retrieval",
          },
        },
        {
          idempotencyKey:
            input.idempotencyKey ||
            `thread-stream:${input.userMessageId}:query-embed`,
          traceId: input.userMessageId,
        },
      )
      .catch((error: unknown) => {
        throw toContentServiceError(error);
      });
    queryEmbedding = embedResult.embedding;
  }

  const lexicalCandidates = await searchChunksByBm25({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    queryText: input.queryText,
    topK: DEFAULT_BM25_TOP_K,
    sourceIds: threadSourceIds.length > 0 ? threadSourceIds : undefined,
  });

  let vectorCandidates: RetrievalCandidate[] = [];
  if (planner.strategy === "ann_hnsw" && planner.requestedDimensions) {
    vectorCandidates = await searchChunksByVectorAnn({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      embeddingProfileId: profile.id,
      queryEmbedding,
      dim: planner.requestedDimensions,
      topK: DEFAULT_VECTOR_TOP_K,
      sourceIds: threadSourceIds.length > 0 ? threadSourceIds : undefined,
    });
  } else if (planner.strategy !== "bm25_only") {
    vectorCandidates = await searchChunksByVectorExact({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      embeddingProfileId: profile.id,
      queryEmbedding,
      topK:
        planner.strategy === "bm25_prefilter_exact"
          ? MAX_VECTOR_PREFILTER
          : DEFAULT_VECTOR_TOP_K,
      sourceIds: threadSourceIds.length > 0 ? threadSourceIds : undefined,
    });
  }

  const fusedCandidates = reciprocalRankFusion(
    vectorCandidates,
    lexicalCandidates,
    8,
  );
  const rerankedCandidates = await rerankCandidates({
    queryText: input.queryText,
    candidates: fusedCandidates,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
  });
  const finalCandidates =
    rerankedCandidates.length > 0 ? rerankedCandidates : fusedCandidates;

  const retrievalRunId = await createRetrievalRun({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    messageId: input.userMessageId,
    embeddingProfileId: profile.id,
    queryText: input.queryText,
    embedModelAlias: profile.providerModelAlias,
    rerankModelAlias: config.litellm.rerankModelAlias || null,
    vectorStrategyUsed: planner.strategy,
    annIndexUsed: planner.annIndexUsed,
    bm25TopK: DEFAULT_BM25_TOP_K,
    vectorTopK: DEFAULT_VECTOR_TOP_K,
    rrfK: DEFAULT_RRF_K,
    prefilterCount:
      planner.strategy === "bm25_prefilter_exact"
        ? lexicalCandidates.length
        : null,
    candidateCount: Math.max(lexicalCandidates.length, vectorCandidates.length),
    finalResultCount: finalCandidates.length,
    latencyMs: Date.now() - startedAt,
    metadataJson: {
      threadSourceIds,
    },
  });

  await createRetrievalHits({
    runId: retrievalRunId,
    hits: [
      ...vectorCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "vector" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
      ...lexicalCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "bm25" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
      ...fusedCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "rrf" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
      ...finalCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "rerank" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
    ],
  });

  return {
    profile,
    planner,
    fusedCandidates: finalCandidates,
    retrievalSummary: buildCitationMetadata(finalCandidates),
  };
}

export class ContentService {
  async createSource(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    estimatedPages?: number;
    parsedTokens?: number;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const source = await createSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeTitle(input.title, "Untitled Source"),
      contentText: input.contentText ?? "",
      createdBy: input.userId,
      estimatedPages: input.estimatedPages,
      parsedTokens: input.parsedTokens,
    });

    return { source };
  }

  async listSources(input: { workspaceId: string; userId: string }) {
    const workspace = await requireWorkspace(input);
    const items = await listSourceRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    return { items };
  }

  async getSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireSource(input);
    const detail = await getSourceDetailRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!detail) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return detail;
  }

  async updateSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
  }) {
    const { workspace, source } = await requireSource(input);

    const updated = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      title:
        input.title !== undefined
          ? normalizeTitle(input.title, source.title)
          : undefined,
      contentText: input.contentText,
      estimatedPages: input.estimatedPages,
      parsedTokens: input.parsedTokens,
    });

    if (!updated) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return { source: updated };
  }

  async deleteSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireSource(input);
    const deleted = await deleteSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!deleted) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return {
      deleted: true as const,
      sourceId: source.id,
    };
  }

  async indexSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
  }) {
    const { workspace, source } = await requireSource(input);

    const profile = await requireDefaultEmbeddingProfile();
    const planner = planRetrievalStrategy(profile);
    const chunkSpecs = chunkSourceContent(source.contentText);

    await updateSourceStatus({
      sourceId: source.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      status: "processing",
      estimatedPages: input.estimatedPages ?? source.estimatedPages,
      parsedTokens: input.parsedTokens ?? source.parsedTokens,
    });

    let embeddings: number[][] = [];
    try {
      if (chunkSpecs.length > 0 && profile.vectorStrategy !== "disabled") {
        const result = await litellm.embeddings
          .embedBatch(
            {
              model: profile.providerModelAlias,
              texts: chunkSpecs.map((chunk) => chunk.content),
              dimensions: planner.requestedDimensions ?? undefined,
              metadata: {
                team_id: workspace.organizationId,
                workspace_id: workspace.id,
                user_id: input.userId,
                feature: "ingestion",
                source_id: source.id,
              },
            },
            {
              idempotencyKey:
                input.idempotencyKey || `source-index:${source.id}:embeddings`,
              traceId: source.id,
            },
          )
          .catch((error: unknown) => {
            throw toContentServiceError(error);
          });

        embeddings = result.embeddings;
      }

      await replaceSourceDocumentsAndEmbeddings({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        sourceTitle: source.title,
        sourceContentText: source.contentText,
        embeddingProfileId: profile.id,
        modelAlias: profile.providerModelAlias,
        embeddings,
        requestedDimensions: planner.requestedDimensions,
      });

      const billing = await billingService.meterIngestion(
        workspace.organizationId,
        {
          workspaceId: workspace.id,
          feature: "ingestion",
          referenceId: `source:${source.id}`,
          idempotencyKey: input.idempotencyKey || `source-index:${source.id}`,
          pages: input.estimatedPages,
          parsedTokens: input.parsedTokens,
        },
        input.userId,
      );

      const updatedSource = await updateSourceStatus({
        sourceId: source.id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        status: "indexed",
        indexedAt: new Date(),
        estimatedPages: input.estimatedPages ?? source.estimatedPages,
        parsedTokens: input.parsedTokens ?? source.parsedTokens,
      });

      return {
        source: updatedSource,
        billing,
        indexing: {
          chunkCount: chunkSpecs.length,
          embeddingProfileId: profile.id,
          vectorStrategy: planner.strategy,
          annIndexUsed: planner.annIndexUsed,
        },
      };
    } catch (error) {
      await updateSourceStatus({
        sourceId: source.id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        status: "failed",
        estimatedPages: input.estimatedPages ?? source.estimatedPages,
        parsedTokens: input.parsedTokens ?? source.parsedTokens,
      });
      throw error;
    }
  }

  async createThread(input: {
    workspaceId: string;
    userId: string;
    title?: string;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await createThreadRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeTitle(input.title, "New Thread"),
      createdBy: input.userId,
    });

    return { thread };
  }

  async listThreadSources(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    const items = await resolveThreadSourceItems({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    });

    return { items };
  }

  async setThreadSources(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    sourceIds: string[];
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    for (const sourceId of input.sourceIds) {
      const source = await findSourceRecord({
        sourceId,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
      });
      if (!source) {
        throw new ContentError(
          404,
          "SOURCE_NOT_FOUND",
          `Source '${sourceId}' not found in workspace`,
        );
      }
    }

    await replaceThreadSourceRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      selectedBy: input.userId,
      sourceIds: [...new Set(input.sourceIds)],
    });

    const items = await resolveThreadSourceItems({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    });

    return { items };
  }

  async streamThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    idempotencyKey?: string;
  }) {
    const messageContent = input.content.trim();
    if (!messageContent) {
      throw new ContentError(
        400,
        "EMPTY_MESSAGE",
        "content is required for thread stream",
      );
    }

    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    const userMessage = await createMessageRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      role: "user",
      content: messageContent,
      createdBy: input.userId,
      metadata: {
        source: "api",
      },
    });

    const retrieval = await runRetrieval({
      workspaceId: workspace.id,
      teamId: workspace.organizationId,
      threadId: thread.id,
      userId: input.userId,
      userMessageId: userMessage.id,
      queryText: messageContent,
      idempotencyKey: input.idempotencyKey,
    });

    const contextBlock = retrieval.fusedCandidates.length
      ? `Context:\n${retrieval.fusedCandidates
          .map(
            (candidate, index) =>
              `[${index + 1}] ${candidate.content.slice(0, 1000)}`,
          )
          .join("\n\n")}`
      : "";

    const modelAlias = config.litellm.chatModelAlias || DEFAULT_MODEL_ALIAS;

    const llmIdempotencyKey =
      input.idempotencyKey || `thread-stream:${userMessage.id}:assistant`;

    const completion = await litellm.chat
      .complete(
        {
          model: modelAlias,
          messages: [
            {
              role: "system",
              content:
                "Use the retrieved context when it is relevant. Cite supporting context using [1], [2], etc. If context is insufficient, answer conservatively.",
            },
            ...(contextBlock
              ? [
                  {
                    role: "system" as const,
                    content: contextBlock,
                  },
                ]
              : []),
            {
              role: "user",
              content: messageContent,
            },
          ],
          metadata: {
            team_id: workspace.organizationId,
            workspace_id: workspace.id,
            user_id: input.userId,
            thread_id: thread.id,
            feature: "chat",
            embedding_profile_id: retrieval.profile.id,
          },
        },
        {
          idempotencyKey: llmIdempotencyKey,
          traceId: userMessage.id,
        },
      )
      .catch((error: unknown) => {
        throw toContentServiceError(error);
      });

    const assistantContent = resolveAssistantContent({
      outputText: completion.outputText,
      toolCalls: completion.message.toolCalls?.map(
        (toolCall: { name: string; argsJson?: string }) => ({
          name: toolCall.name,
          argsJson: toolCall.argsJson,
        }),
      ),
    });

    const providerCostUsd = estimateProviderCostUsd({
      userContent: messageContent,
      assistantContent,
      usage: completion.usage,
    });

    const billing = await billingService.meterConsume(
      workspace.organizationId,
      {
        workspaceId: workspace.id,
        feature: "chat",
        referenceId: `thread:${thread.id}:message:${userMessage.id}`,
        idempotencyKey: llmIdempotencyKey,
        providerCostUsd,
        platformCostUsd: 0.00005,
      },
      input.userId,
    );

    const assistantMessage = await createMessageRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      role: "assistant",
      content: assistantContent,
      createdBy: null,
      model: completion.model || modelAlias,
      creditsConsumed: billing.consumedCredits,
      metadata: {
        providerCostUsd,
        modelAlias,
        finishReason: completion.finishReason,
        usage: completion.usage,
        reasoning: completion.reasoning,
        providerFields: completion.providerFields,
        retrieval: {
          embeddingProfileId: retrieval.profile.id,
          vectorStrategy: retrieval.planner.strategy,
          annIndexUsed: retrieval.planner.annIndexUsed,
          citations: retrieval.retrievalSummary,
        },
      },
    });

    await createCitationRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      messageId: assistantMessage.id,
      citations: retrieval.fusedCandidates.map((candidate, index) => ({
        sourceId: candidate.sourceId,
        documentId: candidate.documentId,
        chunkId: candidate.chunkId,
        quoteText: candidate.content.slice(0, 400),
        rank: index + 1,
        score: candidate.score,
      })),
    });

    return {
      thread,
      userMessage,
      assistantMessage,
      billing,
      retrieval: {
        embeddingProfileId: retrieval.profile.id,
        vectorStrategy: retrieval.planner.strategy,
        annIndexUsed: retrieval.planner.annIndexUsed,
        citations: retrieval.retrievalSummary,
      },
    };
  }
}

export const contentService = new ContentService();
