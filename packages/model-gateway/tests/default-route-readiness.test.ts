import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelGatewayError,
  resolveModelGatewayConfig,
  resolveRequestTarget,
} from "../src/index";

for (const allowNonDefaultAliases of [false, true]) {
  test(`default route readiness is enforced with allowNonDefaultAliases=${allowNonDefaultAliases}`, async () => {
    for (const apiKey of [undefined, "system-secret"]) {
      const config = resolveModelGatewayConfig({
        allowNonDefaultAliases,
        allowedModelAliases: ["custom-alias"],
        providers: {
          default: {
            kind: "openai-compatible",
            baseUrl: "http://local.internal/v1",
            apiKey,
            enabled: false,
            byokEnabled: true,
          },
        },
      });
      await assert.rejects(
        resolveRequestTarget(config, { model: "custom-alias" }),
        (error: unknown) => {
          assert.ok(error instanceof ModelGatewayError);
          assert.equal(error.code, "CONFIGURATION");
          assert.equal(error.retryable, false);
          assert.equal(error.message.includes("system-secret"), false);
          return true;
        },
      );
      const byok = await resolveRequestTarget(config, {
        model: "custom-alias",
        executionMode: "BYOK",
        byok: { provider: "default", apiKey: "workspace-key" },
      });
      assert.equal(byok.apiKey, "workspace-key");
      await assert.rejects(
        resolveRequestTarget(config, {
          model: "custom-alias",
          executionMode: "BYOK",
          byok: { provider: "default" },
        }),
        ModelGatewayError,
      );
    }
  });
}

test("enabled default provider retains arbitrary aliases and respects the provider hint", async () => {
  const config = resolveModelGatewayConfig({
    allowNonDefaultAliases: true,
    providers: {
      default: {
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1",
        apiKey: "system-key",
        enabled: true,
      },
    },
  });
  assert.equal(
    (await resolveRequestTarget(config, { model: "arbitrary-model" }))
      .providerModel,
    "arbitrary-model",
  );
  await assert.rejects(
    resolveRequestTarget(config, {
      model: "arbitrary-model",
      providerHint: "another-provider",
    }),
    ModelGatewayError,
  );
});

for (const excluded of ["provider", "target", "hint"] as const) {
  test(`an explicit route with an excluded ${excluded} fails configuration without selecting an undeclared provider`, async () => {
    const { createModelGateway, isRetryableError } =
      await import("../src/index");
    const { isFailoverableError } = await import("../src/errors");
    let requests = 0;
    const gateway = createModelGateway({
      fetch: async () => {
        requests++;
        throw new Error("No HTTP may run without a ready declared target");
      },
      providers: {
        declared: {
          kind: "openai-compatible",
          baseUrl: "https://declared.internal/v1",
          apiKey: "private-system-key",
          enabled: excluded !== "provider",
        },
        unrelated: {
          kind: "openai-compatible",
          baseUrl: "https://unrelated.internal/v1",
          apiKey: "unrelated-secret",
          enabled: true,
        },
      },
      modelRoutes: {
        model: {
          targets: [
            {
              provider: "declared",
              model: "provider-model",
              enabled: excluded !== "target",
            },
          ],
        },
      },
    });
    const request = {
      model: "model",
      ...(excluded === "hint" ? { providerHint: "unrelated" } : {}),
    };
    const attempts = [
      () =>
        gateway.chat.complete({
          ...request,
          messages: [{ role: "user", content: "test" }],
        }),
      async () => {
        for await (const _event of gateway.chat.stream({
          ...request,
          messages: [{ role: "user", content: "test" }],
        })) {
          assert.fail("A configuration failure cannot emit model output");
        }
      },
      () => gateway.embeddings.embed({ ...request, text: "test" }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, (error: unknown) => {
        assert.ok(ModelGatewayError.isInstance(error));
        assert.equal(error.code, "CONFIGURATION");
        assert.equal(error.retryable, false);
        assert.equal(isRetryableError(error), false);
        assert.equal(isFailoverableError(error), false);
        assert.doesNotMatch(
          JSON.stringify(error),
          /private-system-key|unrelated-secret/,
        );
        return true;
      });
    }
    assert.equal(requests, 0);
  });
}
