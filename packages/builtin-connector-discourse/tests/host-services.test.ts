import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createConnectorAdapters } from "../src/host-services";
import { adapterForum } from "./helpers/adapter-fixtures";
import { startFakeDiscourse } from "./helpers/fake-discourse";

// Records every env name the capability reads, so a test can prove it consults
// exactly DISCOURSE_CONNECTOR_ENABLED and nothing else.
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

// A public fetch scope that fails if ever invoked: adapter construction and
// the activation checks must not perform a request.
function inertPublicFetch(): ConnectorPublicFetchScope {
  return {
    fetch: (() => {
      throw new Error("not called");
    }) as unknown as typeof fetch,
    close: async () => {},
  };
}

test("Discourse capability stays unregistered when the switch is unset, empty, false, or 0", async () => {
  const disabledCases: Record<string, string>[] = [
    {},
    { DISCOURSE_CONNECTOR_ENABLED: "" },
    { DISCOURSE_CONNECTOR_ENABLED: "false" },
    { DISCOURSE_CONNECTOR_ENABLED: "0" },
    { DISCOURSE_CONNECTOR_ENABLED: " FALSE " },
  ];
  for (const values of disabledCases) {
    const { reads, env } = environment(values);
    // No publicFetch is supplied: a disabled connector must not require one.
    const result = await createConnectorAdapters({ env });
    assert.deepEqual(result, { adapters: [], agentToolDefs: [] });
    // The switch is the only env name a disabled capability reads.
    assert.deepEqual(reads, ["DISCOURSE_CONNECTOR_ENABLED"]);
  }
});

test("a disabled Discourse capability never builds the public fetch", async () => {
  const { env } = environment({ DISCOURSE_CONNECTOR_ENABLED: "0" });
  const result = await createConnectorAdapters({
    env,
    publicFetch: () => {
      throw new Error("publicFetch must not be built while disabled");
    },
  });
  assert.equal(result.adapters.length, 0);
});

test("the switch registers a Discourse adapter when enabled", async () => {
  for (const value of ["true", "1", "TRUE", " true "]) {
    const { reads, env } = environment({ DISCOURSE_CONNECTOR_ENABLED: value });
    const result = await createConnectorAdapters({
      env,
      publicFetch: inertPublicFetch,
    });
    assert.deepEqual(result.agentToolDefs, []);
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "discourse");
    assert.deepEqual(manifest.auth, { kind: "none" });
    assert.deepEqual(reads, ["DISCOURSE_CONNECTOR_ENABLED"]);
  }
});

test("Discourse capability rejects a malformed activation value", () => {
  for (const value of ["yes", "no", "enabled", "2"]) {
    const { env } = environment({ DISCOURSE_CONNECTOR_ENABLED: value });
    assert.throws(
      () => createConnectorAdapters({ env, publicFetch: inertPublicFetch }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "DISCOURSE_CONNECTOR_ENABLED must be true, false, 1, or 0",
        );
        return true;
      },
    );
  }
});

test("an enabled Discourse capability fails fast without a host-provided publicFetch", () => {
  const { env } = environment({ DISCOURSE_CONNECTOR_ENABLED: "true" });
  assert.throws(() => createConnectorAdapters({ env }), /publicFetch/);
});

test("the registered adapter is the real one, built on the host's public fetch", async () => {
  const fake = startFakeDiscourse(adapterForum());
  let opened = 0;
  let closed = 0;
  const { env } = environment({ DISCOURSE_CONNECTOR_ENABLED: "true" });
  const result = await createConnectorAdapters({
    env,
    publicFetch: () => {
      opened += 1;
      return {
        fetch: fake.fetch,
        close: async () => {
          closed += 1;
        },
      };
    },
  });
  // Construction opens no scope: scopes are per operation.
  assert.equal(opened, 0);
  const adapter = result.adapters[0]!;
  assert.equal(adapter.capabilityId, "sourceweft/discourse");
  const browsed = await adapter.executeAction({
    teamId: "t",
    workspaceId: "w",
    connectorId: "c",
    connectorType: "discourse",
    config: { forumUrl: "https://forum.example.com", items: [] },
    accessToken: "",
    actionType: "discourse.browse",
    request: {},
    idempotencyKey: "k",
  });
  const entries = (browsed.result as { entries: unknown[] }).entries;
  assert.equal(entries.length, 4);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.deepEqual(
    fake.requests.map((request) => request.path),
    ["/site.json"],
  );
});
