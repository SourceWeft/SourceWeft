import type { ContentBillingPort } from "../../modules/content/billing-port";
import { requireDefaultModelGatewayProfile } from "./client";
import { withBilledModelGateway } from "./billed-client";

/**
 * One structured-output call on the deployment's default chat model, billed to
 * the person it is run for. For platform features that make a small model call
 * on a user's behalf outside a chat turn (a source guide, source discovery).
 *
 * It never substitutes another model: if the default profile is not usable the
 * call fails and the caller decides what to record. Admission runs before the
 * model is reached, so a requester with no credits is refused first.
 */
export async function completeStructuredWithDefaultChat(input: {
  billing: ContentBillingPort;
  /** The organization the usage is settled against. */
  teamId: string;
  workspaceId: string;
  actorUserId: string;
  /** Idempotency root, e.g. a job id or request id. */
  scopeId: string;
  scopeKind: "worker-job" | "api-request";
  operation: string;
  referenceId: string;
  /**
   * Pins the idempotency key. A call site that has already been metered under
   * a key must keep it, or the same work is charged twice.
   */
  idempotencyKey?: string;
  system: string;
  user: string;
  schema: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
  };
  maxTokens: number;
}): Promise<unknown> {
  const profile = await requireDefaultModelGatewayProfile("chat");

  const completion = await withBilledModelGateway(
    {
      billing: input.billing,
      gatewayConfigId: profile.gatewayConfigId,
      context: {
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        feature: "chat",
        intent: { mode: "billed" },
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
      },
    },
    (gateway) =>
      gateway.chat.complete(
        {
          model: profile.modelAlias,
          profileAlias: profile.profileAlias,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          structuredOutput: input.schema,
          thinking: { mode: "off", enabled: false, includeReasoning: false },
          maxTokens: input.maxTokens,
          temperature: 0.2,
        },
        {
          traceId: input.scopeId,
          operation: input.operation,
          modelKind: "chat",
          gatewayConfigId: profile.gatewayConfigId,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          referenceId: input.referenceId,
          idempotencyKey:
            input.idempotencyKey ?? `${input.operation}:${input.scopeId}`,
        },
      ),
  );
  return completion.structuredOutput;
}
