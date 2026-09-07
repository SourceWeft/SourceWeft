import { GatewayCaller } from "../adapters/gateway-caller";
import { awaitWithSignal } from "../request-options";
import { getRerankTransport } from "../adapters/registry";
import { normalizeGatewayError } from "../errors";
import type {
  RequestOptions,
  RerankInput,
  RerankResult,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

export async function runBridgeRerank(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: RerankInput;
  options?: RequestOptions;
}): Promise<RerankResult> {
  try {
    const injected = input.config.langchainFactories?.createReranker?.({
      target: input.target,
      payload: input.payload,
      options: input.options,
      config: input.config,
    });

    if (injected?.rerank) {
      const rerank = injected.rerank.bind(injected);
      const docs = input.payload.documents.map((document) => ({
        pageContent:
          typeof document === "string" ? document : JSON.stringify(document),
        metadata: typeof document === "string" ? undefined : document,
      }));
      const rawResults = await awaitWithSignal(input.options?.signal, () =>
        rerank(docs, input.payload.query, {
          topN: input.payload.topN,
        }),
      );
      const results = rawResults.map((item) => ({
        index: item.index,
        relevanceScore: item.relevanceScore,
        document: input.payload.returnDocuments
          ? typeof input.payload.documents[item.index] === "string"
            ? undefined
            : (input.payload.documents[item.index] as Record<string, unknown>)
          : undefined,
      }));

      return {
        model: input.target.providerModel,
        results,
        provider: input.target.provider,
        providerModel: input.target.providerModel,
        routeDecision: input.target.routeDecision,
        traceId: input.options?.traceId,
        raw: {
          provider: input.target.provider,
          providerModel: input.target.providerModel,
          results: rawResults,
        },
      };
    }

    return await awaitWithSignal(input.options?.signal, () =>
      new GatewayCaller(input.options).call(async () => {
        input.options?.signal?.throwIfAborted();
        return getRerankTransport(input.target.providerKind).execute({
          target: input.target,
          payload: input.payload,
          options: input.options,
          fetch: input.config.fetch,
        });
      }),
    );
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
