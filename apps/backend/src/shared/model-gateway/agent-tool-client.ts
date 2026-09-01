import { createHash } from "node:crypto";
import type {
  AgentToolModelCallOptions,
  AgentToolModelClientRequest,
  AgentToolModelGatewayService,
} from "@sourceweft/contracts/agent-tools";
import type { ContentBillingPort } from "../../modules/content/billing-port";
import type { LlmExecutionConfig } from "../../modules/content/model-gateway-audit";
import type { ModelProfileKind } from "../../modules/content/types";
import {
  withBilledModelGateway,
  type BilledModelGateway,
  type BilledRequestOptions,
} from "./billed-client";
import type { ModelUsageContext } from "./billing/context";

/**
 * The billed gateway as an agent tool is allowed to see it.
 *
 * Two members of `BilledModelGateway` are deliberately absent. `chat.stream`
 * returns an async iterable, so its billing scope has to outlive the callback
 * every call below is wrapped in — serving it here would settle the scope
 * before the first chunk was read. `agentChatModel` is not a `(request,
 * options)` call at all; it hands back a LangChain model that bills on its own
 * schedule. Both are reachable through `openBilledModelGateway` by a host
 * module that can own the scope's lifetime, and no capability has asked for
 * either.
 */
export type AgentToolBilledGatewaySurface = Omit<
  BilledModelGateway,
  "agentChatModel" | "chat"
> & {
  readonly chat: Pick<BilledModelGateway["chat"], "complete">;
};

/**
 * Every model kind the gateway exposes, and the calls each one answers.
 *
 * This table is the whole reason a capability is not restricted to one
 * modality: the client is built by walking it, so the host never names a kind
 * on behalf of whoever is calling. `satisfies` keeps it exhaustive — a kind
 * added to the gateway and forgotten here fails to compile rather than
 * quietly going missing from every capability's client.
 */
const BILLED_MODEL_SURFACES = {
  asr: ["transcribe"],
  chat: ["complete"],
  embeddings: ["embed", "embedBatch"],
  images: ["generate"],
  rerank: ["rank"],
  tts: ["speech"],
} as const satisfies {
  readonly [Kind in keyof AgentToolBilledGatewaySurface]: readonly (string &
    keyof AgentToolBilledGatewaySurface[Kind])[];
};

/**
 * The billing identity a capability supplies, in the shape the billed gateway
 * takes. `modelKind` and `llm` are widened in the contract — a capability
 * package cannot import the backend's unions — so they are narrowed back here,
 * at the boundary that owns them.
 */
function toBilledRequestOptions(
  options: AgentToolModelCallOptions,
  scopeId: string,
): BilledRequestOptions {
  return {
    traceId: options.traceId,
    operation: options.operation,
    modelKind: options.modelKind as ModelProfileKind,
    gatewayConfigId: options.gatewayConfigId,
    profileAlias: options.profileAlias,
    modelAlias: options.modelAlias,
    referenceId: options.referenceId,
    idempotencyKey: agentToolBillingIdempotencyKey(
      scopeId,
      options.idempotencyKey,
    ),
    signal: options.signal,
    llm: options.llm as LlmExecutionConfig | undefined,
    billingMetadata: options.billingMetadata,
  };
}

export function agentToolBillingIdempotencyKey(
  scopeId: string,
  semanticKey: string,
) {
  return createHash("sha256")
    .update(`${scopeId}\0${semanticKey}`)
    .digest("hex");
}

/** The gateway's own call, and the capability-facing one it is wrapped in. */
type BilledGatewayCall = (
  request: unknown,
  options: BilledRequestOptions,
) => Promise<unknown>;

type AgentToolGatewayCall = (
  request: unknown,
  options: AgentToolModelCallOptions,
) => Promise<unknown>;

export type AgentToolModelGatewayScope = Omit<ModelUsageContext, "feature">;

/**
 * Hands tool runtimes a gateway that bills for itself.
 *
 * The scope's tenancy and idempotency root are the turn's, fixed here; the
 * feature the spend is filed under comes from the caller, because the host has
 * no way to know what a capability's call is for. It used to assume one, which
 * meant one capability's label on every capability's spend.
 */
export function createAgentToolModelGatewayService(input: {
  readonly billing: ContentBillingPort;
  readonly scope: AgentToolModelGatewayScope;
}): AgentToolModelGatewayService<AgentToolBilledGatewaySurface> {
  return {
    getClient: async (request: AgentToolModelClientRequest) => {
      const client: Record<string, Record<string, AgentToolGatewayCall>> = {};
      for (const [kind, methods] of Object.entries(BILLED_MODEL_SURFACES)) {
        const surface: Record<string, AgentToolGatewayCall> = {};
        for (const method of methods as readonly string[]) {
          surface[method] = (
            modelRequest: unknown,
            options: AgentToolModelCallOptions,
          ) =>
            withBilledModelGateway(
              {
                billing: input.billing,
                gatewayConfigId: request.gatewayConfigId,
                context: { ...input.scope, feature: request.feature },
              },
              (gateway) => {
                // The one cast in this file: the surface/method pair comes from
                // the table above, which `satisfies` has already checked
                // against the gateway's own type, so the lookup is sound but
                // not expressible while iterating it as data.
                const call = (
                  gateway as unknown as Record<
                    string,
                    Record<string, BilledGatewayCall>
                  >
                )[kind]![method]!;
                return call(
                  modelRequest,
                  toBilledRequestOptions(options, input.scope.scopeId),
                );
              },
            );
        }
        client[kind] = surface;
      }
      return client as unknown as Awaited<
        ReturnType<
          AgentToolModelGatewayService<AgentToolBilledGatewaySurface>["getClient"]
        >
      >;
    },
  };
}
