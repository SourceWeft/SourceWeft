import type { ChunkSpec } from "../content/types";
import type { ContentBillingPort } from "../content/billing-port";
import { ContentError } from "../content/errors";
import { toContentError } from "../content/model-gateway-error";
import { recordGatewayOperationEvent } from "../content/model-gateway-audit";
import { requireContentSource } from "./guards";
import {
  ensureModelConfigAvailable,
  withBilledModelGateway,
} from "../../shared/model-gateway/index";
import {
  prepareEmbeddingProfile,
  validateEmbeddingResult,
} from "../../shared/model-gateway/embedding-identity";
import { chunkSourceContent } from "./chunker";
import { planRetrievalStrategy } from "./retrieval-planner";
import {
  createSourceDocumentChunksAndEmbeddings,
  isLatestSourceRevision,
  listSourceRevisionRecords,
  updateSourceStatus,
  updateSourceStatusForLatestRevision,
} from "./repository";
import { resolveBillingPages } from "./billing-pages";

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

export class SourceIndexingService {
  constructor(private readonly billing: ContentBillingPort) {}

  async indexSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: readonly ChunkSpec[];
  }) {
    return this.indexSourceInternal({ ...input, staleMode: "error" });
  }

  async indexSourceRevision(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    sourceRevisionId: string;
    estimatedPages?: number;
    parsedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: readonly ChunkSpec[];
  }) {
    return this.indexSourceInternal({ ...input, staleMode: "noop" });
  }

  private async indexSourceInternal(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: readonly ChunkSpec[];
    sourceRevisionId?: string;
    staleMode: "error" | "noop";
  }) {
    const { workspace, source } = await requireContentSource(input);

    await ensureModelConfigAvailable();
    const preparedEmbedding = await prepareEmbeddingProfile();
    const profile = {
      ...preparedEmbedding.profile,
      kind: "embedding" as const,
    };
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
    const sourceRevisionId =
      input.sourceRevisionId ?? latestRevision?.id ?? null;

    if (sourceRevisionId) {
      const isCurrentRevision = await isLatestSourceRevision({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        sourceRevisionId,
      });

      if (!isCurrentRevision) {
        return this.handleStaleRevision(
          source,
          chunkSpecs.length,
          input.staleMode,
        );
      }
    }

    let estimatedPages = input.estimatedPages ?? source.estimatedPages;
    const parsedTokens = input.parsedTokens ?? source.parsedTokens;

    const processingSource = input.sourceRevisionId
      ? await updateSourceStatusForLatestRevision({
          sourceId: source.id,
          sourceRevisionId: input.sourceRevisionId,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "processing",
          estimatedPages,
          parsedTokens,
        })
      : await updateSourceStatus({
          sourceId: source.id,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "processing",
          estimatedPages,
          parsedTokens,
        });
    if (!processingSource) {
      return this.handleStaleRevision(
        source,
        chunkSpecs.length,
        input.staleMode,
      );
    }

    let embeddings: number[][] = [];
    try {
      const billingPages = resolveBillingPages({
        parsedPages: input.parsedPages,
        estimatedPages: input.estimatedPages,
        sourceEstimatedPages: source.estimatedPages,
        chunkCount: chunkSpecs.length,
        contentText: source.contentText,
      });
      estimatedPages ??= billingPages;

      if (chunkSpecs.length > 0 && profile.vectorStrategy !== "disabled") {
        const embedStartedAt = Date.now();
        const result = await withBilledModelGateway(
          {
            billing: this.billing,
            gatewayConfigId: profile.gatewayConfigId,
            routedConfig: preparedEmbedding.routedConfig,
            context: {
              teamId: workspace.organizationId,
              workspaceId: workspace.id,
              actorUserId: input.userId,
              feature: "ingestion",
              // Ingestion is billed per page via `meterIngestion` below, so the
              // per-token embedding cost is recorded but never charged.
              intent: {
                mode: "covered",
                coveredBy: "model_kind_not_user_billed",
              },
              scopeKind: "worker-job",
              scopeId: input.idempotencyKey || `source-index:${source.id}`,
            },
          },
          (gateway) =>
            gateway.embeddings.embedBatch(
              {
                model: profile.profileAlias,
                profileAlias: profile.profileAlias,
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
                operation: "embeddings.embedBatch",
                modelKind: "embedding",
                gatewayConfigId: profile.gatewayConfigId,
                profileAlias: profile.profileAlias,
                modelAlias: profile.modelAlias,
                idempotencyKey:
                  input.idempotencyKey ||
                  `source-index:${source.id}:embeddings`,
                traceId: source.id,
              },
            ),
        )
          .then((result) => {
            validateEmbeddingResult(
              preparedEmbedding.identity,
              result,
              result.embeddings,
            );
            return result;
          })
          .catch(async (error: unknown) => {
            const contentError = toContentError(error);
            await recordGatewayOperationEvent({
              teamId: workspace.organizationId,
              workspaceId: workspace.id,
              userId: input.userId,
              feature: "ingestion",
              operation: "embeddings.embedBatch",
              modelKind: "embedding",
              modelAlias: profile.modelAlias,
              traceId: source.id,
              success: false,
              errorCode: contentError.code,
              errorMessage: contentError.message,
              latencyMs: Date.now() - embedStartedAt,
              attributes: {
                sourceId: source.id,
                chunkCount: chunkSpecs.length,
              },
            });
            throw contentError;
          });

        await recordGatewayOperationEvent({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          userId: input.userId,
          feature: "ingestion",
          operation: "embeddings.embedBatch",
          modelKind: "embedding",
          modelAlias: profile.modelAlias,
          provider: result.provider,
          routeDecision: result.routeDecision as unknown as Record<
            string,
            unknown
          > | null,
          usage: result.usage,
          traceId: source.id,
          success: true,
          latencyMs: Date.now() - embedStartedAt,
          attributes: {
            sourceId: source.id,
            chunkCount: chunkSpecs.length,
            embeddingCount: result.embeddings.length,
          },
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
        embeddingIdentity: preparedEmbedding.identity,
        modelAlias: profile.modelAlias,
        embeddings,
        requireEmbeddings:
          chunkSpecs.length > 0 && profile.vectorStrategy !== "disabled",
        requestedDimensions: planner.requestedDimensions,
        chunks: chunkSpecs,
        parsingConfig: source.parsingConfig,
        markSourceIndexed: true,
        estimatedPages,
        parsedTokens,
      });

      if (!writeResult) {
        return this.handleStaleRevision(
          source,
          chunkSpecs.length,
          input.staleMode,
        );
      }

      if (sourceRevisionId) {
        const isCurrentRevision = await isLatestSourceRevision({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          sourceId: source.id,
          sourceRevisionId,
        });

        if (!isCurrentRevision) {
          return this.handleStaleRevision(
            source,
            chunkSpecs.length,
            input.staleMode,
          );
        }
      }

      const billing = await this.billing.meterIngestion(
        workspace.organizationId,
        {
          workspaceId: workspace.id,
          feature: "ingestion",
          referenceId: `source:${source.id}`,
          idempotencyKey: input.idempotencyKey || `source-index:${source.id}`,
          pages: billingPages,
        },
        input.userId,
      );

      const updatedSource =
        writeResult.source ??
        (await updateSourceStatus({
          sourceId: source.id,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "indexed",
          indexedAt: new Date(),
          estimatedPages,
          parsedTokens,
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
          return this.handleStaleRevision(
            source,
            chunkSpecs.length,
            input.staleMode,
          );
        }
      }

      if (input.sourceRevisionId) {
        const failedSource = await updateSourceStatusForLatestRevision({
          sourceId: source.id,
          sourceRevisionId: input.sourceRevisionId,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "failed",
          estimatedPages,
          parsedTokens,
        });

        if (!failedSource) {
          return this.handleStaleRevision(
            source,
            chunkSpecs.length,
            input.staleMode,
          );
        }
      } else {
        await updateSourceStatus({
          sourceId: source.id,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          status: "failed",
          estimatedPages,
          parsedTokens,
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
