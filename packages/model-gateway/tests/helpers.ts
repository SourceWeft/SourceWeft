import type { ResolvedRequestTarget, RouteDecision } from "../src/types";

export type ResolvedTargetOverrides = Partial<
  Omit<ResolvedRequestTarget, "routeDecision">
> & {
  readonly routeDecision?: Partial<RouteDecision>;
};

/**
 * A GLOBAL OpenAI chat target with a matching route decision.
 *
 * The route decision follows the top-level `provider` / `providerKind` unless
 * a test overrides it separately, which is what almost every inline target
 * repeated by hand.
 */
export function makeResolvedTarget(
  overrides: ResolvedTargetOverrides = {},
): ResolvedRequestTarget {
  const { routeDecision, ...target } = overrides;
  const provider = target.provider ?? "openai";
  const providerKind = target.providerKind ?? "openai";
  return {
    provider,
    providerKind,
    providerModel: "test-model",
    baseUrl: "https://gateway.example.com",
    apiKey: "test-key",
    defaultHeaders: {},
    supports: ["chat", "tool_calling", "json_schema"],
    requestMetadata: {},
    ...target,
    routeDecision: {
      alias: "chat-default",
      mode: "GLOBAL",
      strategy: "priority",
      provider,
      providerKind,
      ...routeDecision,
    },
  };
}

export function createJsonResponse(
  body: unknown,
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export function createSseResponse(
  events: string[],
  init?: ResponseInit,
): Response {
  const encoder = new TextEncoder();
  let index = 0;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = events[index];
      if (next === undefined) {
        controller.close();
        return;
      }

      controller.enqueue(encoder.encode(next));
      index += 1;
    },
  });

  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...(init?.headers ?? {}),
    },
  });
}
