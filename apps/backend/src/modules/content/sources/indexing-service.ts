import type { ChunkSpec } from "../types";
import type { ContentBillingPort } from "../billing-port";
import { ContentError } from "../errors";
import { toContentServiceError } from "../model-gateway-error";
import { requireContentSource } from "../content-support";
import {
  ensureModelConfigAvailable,
  getModelGatewayClient,
  requireDefaultModelGatewayProfile,
} from "../../../shared/model-gateway/index";
import { chunkSourceContent } from "../chunker";
import { planRetrievalStrategy } from "../retrieval/planner";
import {
  createSourceDocumentChunksAndEmbeddings,
  isLatestSourceRevision,
  listSourceRevisionRecords,
  updateSourceStatus,
  updateSourceStatusForLatestRevision,
} from "./repository";

type StaleIndexingResult = {
  stale: true;
  source: Awaited<ReturnType<typeof requireContentSource>>["source"];
  billing: null;
  indexing: {
    chunkCount: number;
    embeddingProfileId: null;
    vectorStrategy: null;
    annIndexUsed: null;
  };
};

async function requireDefaultEmbeddingProfile() {
  try {
    const profile = await requireDefaultModelGatewayProfile("embedding");
    return {
      ...profile,
      kind: "embedding" as const,
    };
  } catch {
    throw new ContentError(
      500,
      "EMBEDDING_PROFILE_NOT_CONFIGURED",
      "Default embedding profile is not configured",
    );
  }
}

export class SourceIndexingService {
  constructor(private readonly billing: ContentBillingPort) {}

  async indexSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: ChunkSpec[];
  }) {
    return this.indexSourceInternal({ ...input, staleMode: "error" });
  }

  async indexSourceRevision(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    sourceRevisionId: string;
    estimatedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: ChunkSpec[];
  }) {
    return this.indexSourceInternal({ ...input, staleMode: "noop" });
  }

  private async indexSourceInternal(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: ChunkSpec[];
    sourceRevisionId?: string;
    staleMode: "error" | "noop";
  }) {
    const { workspace, source } = await requireContentSource(input);

    await ensureModelConfigAvailable();
    const profile = await requireDefaultEmbeddingProfile();
    const embeddingGateway = await getModelGatewayClient(
      profile.gatewayConfigId,
    );
    const planner = planRetrievalStrategy(profile);
    const chunkSpecs =
      input.chunks ??
      (await chunkSourceContent(source.contentText, source.parsingConfig));
    const sourceRevisions = await listSourceRevisionRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });
    const latestRevision =
      sourceRevisions.find((revision) => revision.isLatest) ??
      sourceRevisions[0] ??
      null;
    const sourceRevisionId = input.sourceRevisionId ?? latestRevision?.id ?? null;

    if (sourceRevisionId) {
      const isCurrentRevision = await isLatestSourceRevision({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        sourceRevisionId,
      });

      if (!isCurrentRevision) {
        return this.handleStaleRevision(source, chunkSpecs.length, input.staleMode);
      }
    }

    const processingSource = input.sourceRevisionId
      ? await updateSourceStatusForLatestRevision({
          sourceId: source.id,
          sourceRevisionId: input.sourceRevisionId,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "processing",
          estimatedPages: input.estimatedPages ?? source.estimatedPages,
          parsedTokens: input.parsedTokens ?? source.parsedTokens,
        })
      : await updateSourceStatus({
          sourceId: source.id,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "processing",
          estimatedPages: input.estimatedPages ?? source.estimatedPages,
          parsedTokens: input.parsedTokens ?? source.parsedTokens,
        });
    if (!processingSource) {
      return this.handleStaleRevision(source, chunkSpecs.length, input.staleMode);
    }

    let embeddings: number[][] = [];
    try {
      if (chunkSpecs.length > 0 && profile.vectorStrategy !== "disabled") {
        const result = await embeddingGateway.embeddings
          .embedBatch(
            {
              model: profile.modelAlias,
              texts: chunkSpecs.map((chunk) => chunk.text),
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

      const writeResult = await createSourceDocumentChunksAndEmbeddings({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        sourceRevisionId,
        sourceTitle: source.title,
        sourceContentText: source.contentText,
        embeddingProfileId: profile.id,
        modelAlias: profile.modelAlias,
        embeddings,
        requireEmbeddings:
          chunkSpecs.length > 0 && profile.vectorStrategy !== "disabled",
        requestedDimensions: planner.requestedDimensions,
        chunks: chunkSpecs,
        parsingConfig: source.parsingConfig,
        markSourceIndexed: true,
        estimatedPages: input.estimatedPages ?? source.estimatedPages,
        parsedTokens: input.parsedTokens ?? source.parsedTokens,
      });

      if (!writeResult) {
        return this.handleStaleRevision(source, chunkSpecs.length, input.staleMode);
      }

      if (sourceRevisionId) {
        const isCurrentRevision = await isLatestSourceRevision({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          sourceId: source.id,
          sourceRevisionId,
        });

        if (!isCurrentRevision) {
          return this.handleStaleRevision(source, chunkSpecs.length, input.staleMode);
        }
      }

      const billing = await this.billing.meterIngestion(
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

      const updatedSource = writeResult.source ?? (await updateSourceStatus({
        sourceId: source.id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        status: "indexed",
        indexedAt: new Date(),
        estimatedPages: input.estimatedPages ?? source.estimatedPages,
        parsedTokens: input.parsedTokens ?? source.parsedTokens,
      }));

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
      if (input.sourceRevisionId) {
        const isCurrentRevision = await isLatestSourceRevision({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          sourceId: source.id,
          sourceRevisionId: input.sourceRevisionId,
        });

        if (!isCurrentRevision) {
          return this.handleStaleRevision(source, chunkSpecs.length, input.staleMode);
        }
      }

      if (input.sourceRevisionId) {
        const failedSource = await updateSourceStatusForLatestRevision({
          sourceId: source.id,
          sourceRevisionId: input.sourceRevisionId,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "failed",
          estimatedPages: input.estimatedPages ?? source.estimatedPages,
          parsedTokens: input.parsedTokens ?? source.parsedTokens,
        });

        if (!failedSource) {
          return this.handleStaleRevision(source, chunkSpecs.length, input.staleMode);
        }
      } else {
        await updateSourceStatus({
          sourceId: source.id,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "failed",
          estimatedPages: input.estimatedPages ?? source.estimatedPages,
          parsedTokens: input.parsedTokens ?? source.parsedTokens,
        });
      }
      throw error;
    }
  }

  private handleStaleRevision(
    source: Awaited<ReturnType<typeof requireContentSource>>["source"],
    chunkCount: number,
    staleMode: "error" | "noop",
  ) {
    if (staleMode === "error") {
      throw new ContentError(
        409,
        "SOURCE_REVISION_CONFLICT",
        "Source revision changed while indexing",
      );
    }

    return this.staleResult(source, chunkCount);
  }

  private staleResult(
    source: Awaited<ReturnType<typeof requireContentSource>>["source"],
    chunkCount: number,
  ): StaleIndexingResult {
    return {
      stale: true,
      source,
      billing: null,
      indexing: {
        chunkCount,
        embeddingProfileId: null,
        vectorStrategy: null,
        annIndexUsed: null,
      },
    };
  }
}
