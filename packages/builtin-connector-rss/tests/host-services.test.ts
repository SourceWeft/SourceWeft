import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorAdapters } from "../src/host-services";

// Records every env name the capability reads, so a test can prove it consults
// exactly RSS_CONNECTOR_ENABLED and nothing else.
function environment(values: Record<string, string> = {}) {
  const reads: string[] = [];
  return {
    reads,
    env: {
      baseUrl: "https://api.sourceweft.example",
      get(name: string): string | undefined {
        reads.push(name);
        return values[name];
      },
    },
  };
}

// A publicFetch scope whose fetch fails if ever invoked: adapter construction
// and the activation checks must not perform a request.
function inertPublicFetch() {
  return {
    fetch: (() => {
      throw new Error("not called");
    }) as unknown as typeof fetch,
    close: async () => {},
  };
}

test("RSS capability stays unregistered when the switch is unset, empty, false, or 0", async () => {
  const disabledCases: Record<string, string>[] = [
    {},
    { RSS_CONNECTOR_ENABLED: "" },
    { RSS_CONNECTOR_ENABLED: "false" },
    { RSS_CONNECTOR_ENABLED: "0" },
    { RSS_CONNECTOR_ENABLED: " FALSE " },
  ];
  for (const values of disabledCases) {
    const { reads, env } = environment(values);
    // No publicFetch is supplied: a disabled connector must not require one.
    const result = await createConnectorAdapters({ env });
    assert.equal(result.adapters.length, 0);
    assert.equal(result.agentToolDefs.length, 0);
    // The switch is the only env name a disabled capability reads.
    assert.deepEqual(reads, ["RSS_CONNECTOR_ENABLED"]);
  }
});

test("a disabled RSS capability never builds the public fetch", async () => {
  const { env } = environment({ RSS_CONNECTOR_ENABLED: "0" });
  const result = await createConnectorAdapters({
    env,
    publicFetch: () => {
      throw new Error("publicFetch must not be built while disabled");
    },
  });
  assert.equal(result.adapters.length, 0);
  assert.equal(result.agentToolDefs.length, 0);
});

test("RSS capability registers one none-auth adapter without OAuth methods when enabled", async () => {
  for (const value of ["true", "1", "TRUE", " true "]) {
    const { reads, env } = environment({ RSS_CONNECTOR_ENABLED: value });
    const result = await createConnectorAdapters({
      env,
      publicFetch: inertPublicFetch,
    });
    assert.deepEqual(result.agentToolDefs, []);
    assert.equal(result.adapters.length, 1);
    const adapter = result.adapters[0]!;
    assert.equal(adapter.getManifest().type, "rss");
    assert.equal(adapter.getManifest().auth.kind, "none");
    assert.equal(adapter.exchangeOAuthCode, undefined);
    assert.equal(adapter.refreshOAuthToken, undefined);
    // Only the switch is read; the adapter builds lazily and touches no env.
    assert.deepEqual(reads, ["RSS_CONNECTOR_ENABLED"]);
  }
});

test("RSS capability rejects a malformed activation value", () => {
  const { env } = environment({ RSS_CONNECTOR_ENABLED: "yes" });
  assert.throws(
    () => createConnectorAdapters({ env, publicFetch: inertPublicFetch }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "RSS_CONNECTOR_ENABLED must be true, false, 1, or 0",
      );
      return true;
    },
  );
});

test("an enabled RSS capability fails fast without a host-provided public fetch", () => {
  const { env } = environment({ RSS_CONNECTOR_ENABLED: "true" });
  assert.throws(() => createConnectorAdapters({ env }), /publicFetch/);
});

test("the registered adapter logs through the host logger without the feed URL", async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const items = Array.from(
    { length: 501 },
    (_, i) => `<item><title>x</title><guid>g${i}</guid></item>`,
  ).join("");
  const { env } = environment({ RSS_CONNECTOR_ENABLED: "true" });
  const result = await createConnectorAdapters({
    env,
    logger: { warn: (message, meta) => void warnings.push({ message, meta }) },
    publicFetch: () => ({
      fetch: (async () =>
        new Response(
          `<rss version="2.0"><channel><title>T</title>${items}</channel></rss>`,
        )) as unknown as typeof fetch,
      close: async () => {},
    }),
  });
  const adapter = result.adapters[0]!;
  for await (const _page of adapter.discoverPages!({
    teamId: "t",
    workspaceId: "w",
    connectorId: "c",
    connectorType: "rss",
    config: { feedUrl: "https://h.example/feed?token=SECRET-TOKEN-123" },
    accessToken: "",
  })) {
    // drained
  }
  assert.deepEqual(warnings, [
    {
      message: "rss_feed_truncated",
      meta: { feedHost: "h.example", kept: 500 },
    },
  ]);
});
