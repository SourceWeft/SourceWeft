import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createConnectorAdapters } from "../src/host-services";

// Records every env name the capability reads, so a test can prove it consults
// exactly ZOTERO_CONNECTOR_ENABLED and nothing else.
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

// A credentialed fetch scope whose fetch fails if ever invoked: adapter
// construction and the activation checks must not perform a request.
function inertCredentialedFetch(): ConnectorPublicFetchScope {
  return {
    fetch: (() => {
      throw new Error("not called");
    }) as unknown as typeof fetch,
    close: async () => {},
  };
}

test("Zotero capability stays unregistered when the switch is unset, empty, false, or 0", async () => {
  const disabledCases: Record<string, string>[] = [
    {},
    { ZOTERO_CONNECTOR_ENABLED: "" },
    { ZOTERO_CONNECTOR_ENABLED: "false" },
    { ZOTERO_CONNECTOR_ENABLED: "0" },
    { ZOTERO_CONNECTOR_ENABLED: " FALSE " },
  ];
  for (const values of disabledCases) {
    const { reads, env } = environment(values);
    // No credentialedFetch is supplied: a disabled connector must not require one.
    const result = await createConnectorAdapters({ env });
    assert.equal(result.adapters.length, 0);
    assert.equal(result.agentToolDefs.length, 0);
    // The switch is the only env name a disabled capability reads.
    assert.deepEqual(reads, ["ZOTERO_CONNECTOR_ENABLED"]);
  }
});

test("a disabled Zotero capability never builds the credentialed fetch", async () => {
  const { env } = environment({ ZOTERO_CONNECTOR_ENABLED: "0" });
  const result = await createConnectorAdapters({
    env,
    credentialedFetch: () => {
      throw new Error("credentialedFetch must not be built while disabled");
    },
  });
  assert.equal(result.adapters.length, 0);
  assert.equal(result.agentToolDefs.length, 0);
});

test("the switch registers the Zotero credential adapter when enabled", async () => {
  for (const value of ["true", "1", "TRUE", " true "]) {
    const { reads, env } = environment({ ZOTERO_CONNECTOR_ENABLED: value });
    const result = await createConnectorAdapters({
      env,
      credentialedFetch: inertCredentialedFetch,
    });
    assert.deepEqual(result.agentToolDefs, []);
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "zotero");
    assert.deepEqual(manifest.auth, { kind: "credential", scheme: "api_key" });
    // Only the one switch is read.
    assert.deepEqual(reads, ["ZOTERO_CONNECTOR_ENABLED"]);
  }
});

test("Zotero capability rejects a malformed activation value", () => {
  for (const value of ["yes", "no", "enabled", "2"]) {
    const { env } = environment({ ZOTERO_CONNECTOR_ENABLED: value });
    assert.throws(
      () =>
        createConnectorAdapters({
          env,
          credentialedFetch: inertCredentialedFetch,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "ZOTERO_CONNECTOR_ENABLED must be true, false, 1, or 0",
        );
        return true;
      },
    );
  }
});

test("an enabled Zotero capability fails fast without a host-provided credentialed fetch", () => {
  const { env } = environment({ ZOTERO_CONNECTOR_ENABLED: "true" });
  assert.throws(() => createConnectorAdapters({ env }), /credentialedFetch/);
});
