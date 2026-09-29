import { sdkRetryOptions } from "./gateway-caller";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatAdapter } from "./types";
import type { ProviderRoutingConfig } from "../types";
import { buildOpenAIReasoningModelKwargs } from "./openai-reasoning";
import { captureProviderResponseFetch } from "../observation/response-capture";
import { ModelGatewayError } from "../errors";
import { isRecord } from "../utils/object";

function mergeOpenRouterProviderRouting(
  extraBody: Record<string, unknown> | undefined,
  providerRouting: ProviderRoutingConfig | undefined,
): Record<string, unknown> | undefined {
  if (!providerRouting) {
    return extraBody;
  }

  const existingProvider =
    extraBody?.provider &&
    typeof extraBody.provider === "object" &&
    !Array.isArray(extraBody.provider)
      ? (extraBody.provider as Record<string, unknown>)
      : {};

  return {
    ...(extraBody ?? {}),
    provider: {
      ...existingProvider,
      ...(providerRouting.only ? { only: providerRouting.only } : {}),
      ...(providerRouting.sort ? { sort: providerRouting.sort } : {}),
    },
  };
}

/**
 * Adds `provider.require_parameters: true` to every chat-completions request
 * whose body asks for a strict `json_schema` response format
 * (`response_format.json_schema.strict === true`).
 *
 * Without it OpenRouter may route the request to an endpoint of the model that
 * ignores `response_format`, so a strict schema is silently not enforced. With
 * it, OpenRouter only routes to endpoints that support every parameter in the
 * request, and answers 404 "No endpoints found that can handle the requested
 * parameters" when there is none — which the structured-output executor turns
 * into its non-strict fallback.
 *
 * Only strict requests: a non-strict `json_schema` (LangChain's default method
 * for most models, used when a schema is not strict-compatible) keeps today's
 * routing. Requiring parameters there would turn a model without a
 * structured-output endpoint into a 404 that no fallback covers, where today
 * the request is routed and answered.
 *
 * Why a body transform on the adapter's fetch rather than a model option: one
 * model instance serves plain chat, tool calls and, through LangChain's
 * `withStructuredOutput`, a `json_schema` response format; only the final
 * request body shows which one this request is, and every route to a strict
 * `json_schema` request (the gateway's strict plan, a caller-pinned strict
 * `json_schema`) is covered in one place. It runs
 * only in this adapter, so other Providers receive `json_schema` as-is. The
 * flag is merged into the `provider` object already in the body — configured
 * `only`/`sort` and any `extraBody.provider` — and overrides only
 * `require_parameters`. Any body that is not a JSON string passes through
 * untouched.
 */
export function requireParametersForJsonSchema(
  fetchImpl?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const send = fetchImpl ?? globalThis.fetch;
    if (typeof init?.body !== "string") {
      return send(input, init);
    }
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return send(input, init);
    }
    if (
      !isRecord(body) ||
      !isRecord(body.response_format) ||
      body.response_format.type !== "json_schema" ||
      !isRecord(body.response_format.json_schema) ||
      body.response_format.json_schema.strict !== true
    ) {
      return send(input, init);
    }
    const provider = isRecord(body.provider) ? body.provider : {};
    return send(input, {
      ...init,
      body: JSON.stringify({
        ...body,
        provider: { ...provider, require_parameters: true },
      }),
    });
  };
}

export class OpenRouterChatAdapter implements ChatAdapter {
  readonly kind = "openrouter" as const;

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    if (!target.apiKey?.trim()) {
      throw new ModelGatewayError({
        code: "AUTH",
        message: "OpenRouter API key is not configured",
        provider: target.provider,
        retryable: false,
      });
    }

    return new ChatOpenAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      ...sdkRetryOptions(options),
      timeout: options?.timeoutMs,
      apiKey: target.apiKey,
      configuration: {
        ignoreEnvironmentHeaders: true,
        baseURL: target.baseUrl,
        defaultHeaders: target.defaultHeaders,
        fetch: captureProviderResponseFetch(
          requireParametersForJsonSchema(options?.fetch),
        ),
        adminAPIKey: null,
      },
      modelKwargs: {
        ...(mergeOpenRouterProviderRouting(
          input.extraBody,
          target.providerRouting,
        ) ?? {}),
        ...buildOpenAIReasoningModelKwargs(input, {
          unifiedReasoningOff: true,
        }),
      },
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
