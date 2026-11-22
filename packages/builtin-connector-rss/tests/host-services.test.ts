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

test("RSS capability returns an empty contribution once publicFetch is present and never reads env", async () => {
  const result = await createConnectorAdapters({
    env,
    publicFetch: () => ({
      fetch: (() => {
        throw new Error("not called");
      }) as unknown as typeof fetch,
      close: async () => {},
    }),
  });
  assert.deepEqual(result, { adapters: [], agentToolDefs: [] });
});
