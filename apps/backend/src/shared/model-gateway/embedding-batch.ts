import type { ContentBillingPort } from "../../modules/content/billing-port";
import { withBilledModelGateway } from "./billed-client";
import {
  prepareEmbeddingProfile,
  validateEmbeddingResult,
} from "./embedding-identity";

/**
 * One batched embedding call on the deployment's default embedding profile,
 * as covered usage: the cost is recorded against the scope and never charged
 * to the user, the same treatment retrieval and ingestion embeddings get.
 *
 * The result is checked against the profile's identity (model and
 * dimensions), so vectors from a different model can never be compared.
 */
export async function completeEmbeddingBatch(input: {
  billing: ContentBillingPort;
  teamId: string;
  workspaceId: string;
  actorUserId: string;
  threadId?: string;
  scopeId: string;
  feature: string;
  idempotencyKey: string;
  texts: string[];
}): Promise<number[][]> {
  const prepared = await prepareEmbeddingProfile();
  const profile = prepared.profile;
  const result = await withBilledModelGateway(
    {
      billing: input.billing,
      gatewayConfigId: profile.gatewayConfigId,
      routedConfig: prepared.routedConfig,
      context: {
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        feature: input.feature,
        intent: { mode: "covered", coveredBy: "model_kind_not_user_billed" },
        scopeKind: "thread-turn",
        scopeId: input.scopeId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    },
    (gateway) =>
      gateway.embeddings.embedBatch(
        {
          model: profile.profileAlias,
          profileAlias: profile.profileAlias,
          texts: input.texts,
          dimensions: profile.requestedDimensions ?? undefined,
          executionMode: "GLOBAL",
        },
        {
          operation: "embeddings.embedBatch",
          modelKind: "embedding",
          gatewayConfigId: profile.gatewayConfigId,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          idempotencyKey: input.idempotencyKey,
          traceId: input.scopeId,
        },
      ),
  );
  validateEmbeddingResult(prepared.identity, result, result.embeddings);
  return result.embeddings;
}
