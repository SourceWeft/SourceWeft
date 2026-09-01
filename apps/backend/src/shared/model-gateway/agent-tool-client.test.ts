import assert from "node:assert/strict";
import { test, vi } from "vitest";

const billedCall = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("./billed-client", () => ({
  withBilledModelGateway: async (
    _input: unknown,
    run: (gateway: unknown) => Promise<unknown>,
  ) =>
    run({
      images: {
        generate: async (
          _request: unknown,
          options: Record<string, unknown>,
        ) => {
          billedCall.options = options;
          return { images: [], model: "image-model", raw: {} };
        },
      },
    }),
}));

import {
  agentToolBillingIdempotencyKey,
  createAgentToolModelGatewayService,
} from "./agent-tool-client";

test("Agent tool billing replay is stable within a run and distinct across runs", () => {
  const semanticKey = "video-asset:sha256:prompt";
  assert.equal(
    agentToolBillingIdempotencyKey("run-1", semanticKey),
    agentToolBillingIdempotencyKey("run-1", semanticKey),
  );
  assert.notEqual(
    agentToolBillingIdempotencyKey("run-1", semanticKey),
    agentToolBillingIdempotencyKey("run-2", semanticKey),
  );
});

test("Agent tool model calls forward the caller AbortSignal to the billed gateway", async () => {
  const controller = new AbortController();
  const service = createAgentToolModelGatewayService({
    billing: {} as never,
    scope: { scopeId: "run-1" } as never,
  });
  const client = await service.getClient({
    gatewayConfigId: "gateway-1",
    feature: "artifact.video_presentation.asset",
  });

  await client.images.generate(
    { model: "image-model", prompt: "hero" },
    {
      operation: "video.asset.generate",
      modelKind: "image",
      gatewayConfigId: "gateway-1",
      profileAlias: "image-default",
      idempotencyKey: "asset-1",
      signal: controller.signal,
    },
  );

  assert.equal(billedCall.options?.signal, controller.signal);
});
