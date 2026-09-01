import "dotenv/config";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- manual
// smoke probe against an operator-supplied key; intentionally unbilled (see
// the matching exemption in shared/model-gateway/architecture.test.ts).
import {
  createModelGateway,
  getProviderResponseAdapter,
  ProviderReceiptPendingError,
  type ModelCallObservation,
} from "@sourceweft/model-gateway";

const apiKey = process.env.ORCAROUTER_API_KEY?.trim();
const baseUrl = (
  process.env.ORCAROUTER_API_BASE ?? "https://api.orcarouter.ai/v1"
).replace(/\/+$/, "");
if (!apiKey) {
  throw new Error("Missing ORCAROUTER_API_KEY");
}

const gateway = createModelGateway({
  providers: {
    orcarouter: {
      kind: "openai-compatible",
      baseUrl,
      apiKey,
      supports: ["chat", "tool_calling"],
    },
  },
  modelRoutes: {
    "chat-default": {
      strategy: "priority",
      targets: [
        {
          provider: "orcarouter",
          model: "orcarouter/auto",
          priority: 1,
        },
      ],
    },
  },
  timeoutMs: 30_000,
  maxRetries: 0,
});

function assertObservation(
  label: string,
  observation: ModelCallObservation | undefined,
) {
  if (!observation) {
    throw new Error(`${label} did not produce a canonical observation`);
  }
  if (!observation.identity.resolvedProviderModel) {
    throw new Error(`${label} did not report a resolved provider model`);
  }
  if (!observation.identity.providerRequestId) {
    throw new Error(`${label} did not report an Orca request ID`);
  }
  if (observation.cost?.inlineUsd === undefined) {
    throw new Error(`${label} did not report usage.cost_usd`);
  }
  console.log(label, {
    requestedModel: observation.identity.requestedProviderModel,
    resolvedModel: observation.identity.resolvedProviderModel,
    providerRequestId: observation.identity.providerRequestId,
    usage: observation.usage,
    inlineCostUsd: observation.cost.inlineUsd,
  });
  return observation;
}

async function receiptFor(observation: ModelCallObservation) {
  const adapter = getProviderResponseAdapter("orcarouter");
  if (!adapter?.reconcileCost || !observation.identity.providerRequestId) {
    throw new Error("OrcaRouter receipt adapter is unavailable");
  }
  const delays = [1_000, 2_000, 5_000, 10_000];
  for (const delay of delays) {
    try {
      const receipt = await adapter.reconcileCost({
        baseUrl,
        apiKey,
        requestId: observation.identity.providerRequestId,
        fetch: globalThis.fetch,
      });
      console.log("receipt", {
        resolvedModel: receipt.resolvedProviderModel,
        usage: receipt.usage,
        settledCostUsd: receipt.settledCostUsd,
        currency: receipt.currency,
      });
      return receipt;
    } catch (error) {
      if (!(error instanceof ProviderReceiptPendingError)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("OrcaRouter receipt did not settle within the smoke window");
}

const complete = await gateway.chat.complete({
  model: "chat-default",
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
  maxTokens: 16,
});
const completeObservation = assertObservation("complete", complete.observation);
await receiptFor(completeObservation);

let streamObservation: ModelCallObservation | undefined;
for await (const event of gateway.chat.stream({
  model: "chat-default",
  messages: [{ role: "user", content: "Reply with exactly: STREAM_OK" }],
  maxTokens: 16,
})) {
  if (event.type === "error") {
    throw new Error(`OrcaRouter stream failed: ${event.error.message}`);
  }
  if (event.type === "metadata") {
    streamObservation = event.metadata.observation;
  }
}
assertObservation("stream", streamObservation);
