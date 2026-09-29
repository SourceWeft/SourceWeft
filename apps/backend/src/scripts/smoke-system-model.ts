import "dotenv/config";
import { randomUUID } from "node:crypto";
import { closeDatabase } from "@sourceweft/db";
import {
  getSystemModelReadiness,
  withSystemModel,
} from "../shared/model-gateway/system-client";

/**
 * Manual smoke test of the system model: one real structured-output call
 * through `withSystemModel`, against the gateway configuration in
 * DATABASE_URL and the SYSTEM_MODEL_* settings. Prints the readiness, what
 * the provider reported (model, tokens, cost) and the answer; the
 * `system_model.call` line is printed by the logger as for any call. The key
 * is never printed.
 *
 *   SYSTEM_MODEL_ENABLED=true SYSTEM_MODEL_PROVIDER=openrouter \
 *   SYSTEM_MODEL_NAME=deepseek/deepseek-v4.1-flash SYSTEM_MODEL_API_KEY=... \
 *   pnpm --filter @sourceweft/backend exec tsx src/scripts/smoke-system-model.ts
 */

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    colour: { type: "string", description: "One primary colour." },
    reason: { type: "string", description: "One short sentence." },
  },
  required: ["colour", "reason"],
  additionalProperties: false,
};

async function main() {
  const readiness = await getSystemModelReadiness();
  console.log("System model readiness", {
    enabled: readiness.enabled,
    configured: readiness.configured,
    ready: readiness.ready,
    provider: readiness.provider,
    model: readiness.model,
    reason: readiness.reason,
  });
  if (!readiness.ready) {
    process.exitCode = 1;
    return;
  }

  const result = await withSystemModel(
    {
      purpose: "skill_market.evaluation",
      subjectRef: "smoke:system-model",
      scopeId: `smoke-system-model:${randomUUID()}`,
    },
    (chat) =>
      chat.complete({
        messages: [
          {
            role: "system",
            content: "Answer with the structured output only.",
          },
          {
            role: "user",
            content: "Name one primary colour and say why you chose it.",
          },
        ],
        structuredOutput: {
          name: "system_model_smoke",
          description: "A primary colour and a one-sentence reason.",
          schema: ANSWER_SCHEMA,
        },
        thinking: { mode: "off", enabled: false, includeReasoning: false },
        maxTokens: 300,
        temperature: 0,
      }),
  );

  const usage = result.observation?.usage ?? result.usage;
  const cost = result.observation?.cost;
  console.log("System model call", {
    provider: result.provider ?? null,
    requestedModel: result.providerModel ?? null,
    resolvedModel:
      result.observation?.identity.resolvedProviderModel ?? result.model,
    providerRequestId: result.observation?.identity.providerRequestId ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    // The total the provider reported, and what it charged inline — they
    // differ on an OpenRouter BYOK call that reported only its fee.
    costUsd: cost?.effectiveUsd ?? null,
    chargedUsd: cost?.inlineUsd ?? null,
    costSource: cost?.source ?? null,
    costStatus: cost?.status ?? null,
    structuredOutput: result.structuredOutput ?? null,
  });
  if (!result.structuredOutput) {
    throw new Error("The model returned no structured output");
  }
}

main()
  .catch((error: unknown) => {
    // Provider errors can echo request details; print the class and code only.
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    const message =
      error instanceof Error && error.name === "SystemModelUnavailableError"
        ? error.message
        : `${error instanceof Error ? error.name : "Error"}${code ? ` (${code})` : ""}`;
    console.error(`System model smoke failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
