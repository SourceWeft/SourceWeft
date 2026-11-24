import {
  BillingAdmissionError,
  completeStructuredWithDefaultChat,
  isModelGatewayTimeout,
  requireDefaultModelGatewayProfile,
} from "../../shared/model-gateway/index";
import type { ContentBillingPort } from "../content/billing-port";
import {
  GroundedGenerationError,
  GroundedModelTimeoutError,
  type GroundedModelPort,
} from "@sourceweft/contracts/grounded-generation";

/**
 * The deployment's default chat model, or `MODEL_UNAVAILABLE`. Never another
 * profile: a grounded artifact is generated with the default or not at all.
 */
export async function describeDefaultChatModel(
  resolveProfile: (
    kind: "chat",
  ) => Promise<{ modelAlias: string }> = requireDefaultModelGatewayProfile,
): Promise<{ modelAlias: string }> {
  try {
    const profile = await resolveProfile("chat");
    return { modelAlias: profile.modelAlias };
  } catch (error) {
    throw new GroundedGenerationError(
      "MODEL_UNAVAILABLE",
      "The default chat model is not available",
      {},
      { cause: error },
    );
  }
}

/**
 * `GroundedModelPort` over `completeStructuredWithDefaultChat`: the default chat
 * model, billed to the payer, admission before the call, thinking off. A
 * refused admission becomes `INSUFFICIENT_CREDITS`; a call that timed out on
 * every target becomes `GroundedModelTimeoutError`, which a generator may send
 * once more; any other failure is passed on for the job to retry.
 */
export function createGroundedModelPort<Op extends string = string>(input: {
  billing: ContentBillingPort;
  /** The organization the payer's usage is settled against. */
  teamId: string;
  workspaceId: string;
  actorUserId: string;
  /** The queue job id (or, for a synchronous request, the request id): the billing scope of every call. */
  scopeId: string;
  /** A queued job's calls are `worker-job`; a call inside an API request is `api-request`. */
  scopeKind?: "worker-job" | "api-request";
  /** Names the artifact in the refusal message; "artifact" when omitted. */
  subject?: string;
  complete?: typeof completeStructuredWithDefaultChat;
}): GroundedModelPort<Op> {
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
          scopeKind: input.scopeKind ?? "worker-job",
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
          throw new GroundedGenerationError(
            "INSUFFICIENT_CREDITS",
            `Not enough credits to generate this ${input.subject ?? "artifact"}`,
            {},
            { cause: error },
          );
        }
        if (isModelGatewayTimeout(error)) {
          throw new GroundedModelTimeoutError(
            error instanceof Error ? error.message : "The model call timed out",
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}
