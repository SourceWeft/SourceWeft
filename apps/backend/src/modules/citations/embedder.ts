import { completeEmbeddingBatch } from "../../shared/model-gateway/index";
import type { ContentBillingPort } from "../content/billing-port";

/**
 * Embeds texts for the by-meaning pass of citation anchoring (#516). The
 * usage is recorded, not charged (embeddings are a covered model kind, like
 * retrieval and ingestion), and it is made lazily, so an answer that needs no
 * second pass makes no embedding call at all.
 */
export function createCitationEmbedder(input: {
  billing: ContentBillingPort;
  /** The organization the usage is settled against. */
  teamId: string;
  workspaceId: string;
  userId: string;
  threadId: string;
  scopeId: string;
}) {
  return (texts: string[]) =>
    completeEmbeddingBatch({
      billing: input.billing,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      threadId: input.threadId,
      scopeId: input.scopeId,
      feature: "citation-anchoring",
      idempotencyKey: `citation-anchoring:${input.scopeId}`,
      texts,
    });
}
