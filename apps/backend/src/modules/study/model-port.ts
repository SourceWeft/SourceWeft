import {
  BillingAdmissionError,
  completeStructuredWithDefaultChat,
  requireDefaultModelGatewayProfile,
} from "../../shared/model-gateway/index";
import type { ContentBillingPort } from "../content/billing-port";
import {
  StudyGenerationError,
  type StudyModelPort,
} from "@sourceweft/contracts/study-capability";

/**
 * The deployment's default chat model, or `MODEL_UNAVAILABLE`. Never another
 * profile: a study artifact is generated with the default or not at all.
 */
export async function describeStudyModel(
  resolveProfile: (
    kind: "chat",
  ) => Promise<{ modelAlias: string }> = requireDefaultModelGatewayProfile,
): Promise<{ modelAlias: string }> {
  try {
    const profile = await resolveProfile("chat");
    return { modelAlias: profile.modelAlias };
  } catch (error) {
    throw new StudyGenerationError(
      "MODEL_UNAVAILABLE",
      "The default chat model is not available",
      {},
      { cause: error },
    );
  }
}

/**
 * `StudyModelPort` over `completeStructuredWithDefaultChat`: the default chat
 * model, billed to the payer, admission before the call, thinking off. A
 * refused admission becomes `INSUFFICIENT_CREDITS`; any other failure is
 * passed on for the job to retry.
 */
export function createStudyModelPort(input: {
  billing: ContentBillingPort;
  /** The organization the payer's usage is settled against. */
  teamId: string;
  workspaceId: string;
  actorUserId: string;
  /** The queue job id: the billing scope of every call in this run. */
  scopeId: string;
  complete?: typeof completeStructuredWithDefaultChat;
}): StudyModelPort {
  const complete = input.complete ?? completeStructuredWithDefaultChat;
  return {
    async completeStructured(call) {
      try {
        return await complete({
          billing: input.billing,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          scopeId: input.scopeId,
          scopeKind: "worker-job",
          operation: call.operation,
          referenceId: call.referenceId,
          idempotencyKey: call.idempotencyKey,
          system: call.system,
          user: call.user,
          schema: call.schema,
          maxTokens: call.maxTokens,
        });
      } catch (error) {
        if (error instanceof BillingAdmissionError) {
          throw new StudyGenerationError(
            "INSUFFICIENT_CREDITS",
            "Not enough credits to generate this study artifact",
            {},
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}
