import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorAdapters } from "../src/host-services";

// The RSS capability reads no environment variable: visibility is the preview
// gate. An env whose `get` throws proves it is never consulted.
const env = {
  baseUrl: "https://api.sourceweft.example",
  get(name: string): string | undefined {
    throw new Error(`RSS must not read env: ${name}`);
  },
};

test("RSS capability fails fast without a host-provided public fetch", () => {
  assert.throws(() => createConnectorAdapters({ env }), /publicFetch/);
});

test("RSS capability contributes one none-auth adapter without OAuth methods and never reads env", async () => {
  const result = await createConnectorAdapters({
    env,
    publicFetch: () => ({
      fetch: (() => {
        throw new Error("not called");
      }) as unknown as typeof fetch,
      close: async () => {},
    }),
  });
  assert.deepEqual(result.agentToolDefs, []);
  assert.equal(result.adapters.length, 1);
  const adapter = result.adapters[0]!;
  assert.equal(adapter.getManifest().type, "rss");
  assert.equal(adapter.getManifest().auth.kind, "none");
  assert.equal(adapter.exchangeOAuthCode, undefined);
  assert.equal(adapter.refreshOAuthToken, undefined);
});

test("the registered adapter logs through the host logger without the feed URL", async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const items = Array.from(
    { length: 501 },
    (_, i) => `<item><title>x</title><guid>g${i}</guid></item>`,
  ).join("");
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
