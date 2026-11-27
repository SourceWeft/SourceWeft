import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createConnectorAdapters } from "../src/host-services";

// Records every env name the capability reads, so a test can prove it consults
// exactly WORDPRESS_CONNECTOR_ENABLED and nothing else.
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

// A fetch scope that fails if ever invoked: adapter construction and the
// activation checks must not perform a request.
function inertFetch(): ConnectorPublicFetchScope {
  return {
    fetch: (() => {
      throw new Error("not called");
    }) as unknown as typeof fetch,
    close: async () => {},
  };
}

test("WordPress capability stays unregistered when the switch is unset, empty, false, or 0", async () => {
  const disabledCases: Record<string, string>[] = [
    {},
    { WORDPRESS_CONNECTOR_ENABLED: "" },
    { WORDPRESS_CONNECTOR_ENABLED: "false" },
    { WORDPRESS_CONNECTOR_ENABLED: "0" },
    { WORDPRESS_CONNECTOR_ENABLED: " FALSE " },
  ];
  for (const values of disabledCases) {
    const { reads, env } = environment(values);
    // No fetch seam is supplied: a disabled connector must not require one.
    const result = await createConnectorAdapters({ env });
    assert.deepEqual(result, { adapters: [], agentToolDefs: [] });
    assert.deepEqual(reads, ["WORDPRESS_CONNECTOR_ENABLED"]);
  }
});

test("a disabled WordPress capability never builds either fetch", async () => {
  const { env } = environment({ WORDPRESS_CONNECTOR_ENABLED: "0" });
  const result = await createConnectorAdapters({
    env,
    publicFetch: () => {
      throw new Error("publicFetch must not be built while disabled");
    },
    credentialedFetch: () => {
      throw new Error("credentialedFetch must not be built while disabled");
    },
  });
  assert.equal(result.adapters.length, 0);
});

test("the one switch registers both WordPress adapters when enabled", async () => {
  for (const value of ["true", "1", "TRUE", " true "]) {
    const { reads, env } = environment({ WORDPRESS_CONNECTOR_ENABLED: value });
    const result = await createConnectorAdapters({
      env,
      publicFetch: inertFetch,
      credentialedFetch: inertFetch,
    });
    assert.deepEqual(result.agentToolDefs, []);
    assert.deepEqual(
      result.adapters.map((adapter) => adapter.getManifest().type),
      ["wordpress", "wordpress_login"],
    );
    assert.deepEqual(
      result.adapters.map((adapter) => adapter.getManifest().auth),
      [{ kind: "none" }, { kind: "credential", scheme: "basic" }],
    );
    assert.deepEqual(
      result.adapters.map((adapter) => adapter.capabilityId),
      ["sourceweft/wordpress", "sourceweft/wordpress"],
    );
    assert.deepEqual(reads, ["WORDPRESS_CONNECTOR_ENABLED"]);
  }
});

test("WordPress capability rejects a malformed activation value", () => {
  for (const value of ["yes", "no", "enabled", "2"]) {
    const { env } = environment({ WORDPRESS_CONNECTOR_ENABLED: value });
    assert.throws(
      () =>
        createConnectorAdapters({
          env,
          publicFetch: inertFetch,
          credentialedFetch: inertFetch,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "WORDPRESS_CONNECTOR_ENABLED must be true, false, 1, or 0",
        );
        return true;
      },
    );
  }
});

test("an enabled WordPress capability fails fast without publicFetch", () => {
  const { env } = environment({ WORDPRESS_CONNECTOR_ENABLED: "true" });
  assert.throws(
    () => createConnectorAdapters({ env, credentialedFetch: inertFetch }),
    /publicFetch/,
  );
});

test("an enabled WordPress capability fails fast without credentialedFetch", () => {
  const { env } = environment({ WORDPRESS_CONNECTOR_ENABLED: "true" });
  assert.throws(
    () => createConnectorAdapters({ env, publicFetch: inertFetch }),
    /credentialedFetch/,
  );
});

test("an enabled WordPress capability with neither seam names the first missing one", () => {
  const { env } = environment({ WORDPRESS_CONNECTOR_ENABLED: "1" });
  assert.throws(() => createConnectorAdapters({ env }), /publicFetch/);
});
