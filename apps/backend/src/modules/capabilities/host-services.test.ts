import assert from "node:assert/strict";
import { test } from "vitest";
import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import {
  collectCapabilityConnectorContributions,
  createCapabilityHostEnvironment,
  resolveCapabilityWebProvider,
} from "./host-services";
import {
  createSyntheticCapabilityRecord,
  syntheticConnectorAgentToolDefs,
  SYNTHETIC_CONNECTOR_TYPE,
} from "../../test/synthetic-capability";

/**
 * The host's side of the host-service extension point, driven by a synthetic
 * capability.
 *
 * What is asserted is that the host collects from *declarations* — a manifest's
 * connector contributions, a manifest's `hostServices` list — and calls
 * whatever factory the entry module exposes. No real capability appears here on
 * purpose: if these tests bound the Notion connector or the web-search package,
 * they would pass for the wrong reason (the real package is installed) and
 * would stop proving that an arbitrary capability can fill the same seam.
 */

function connectorRecord(): DiscoveredCapabilityRecord {
  const record = createSyntheticCapabilityRecord({ jobName: null });
  return {
    ...record,
    manifest: {
      ...record.manifest,
      contributes: {
        ...record.manifest.contributes,
        connectors: [
          {
            id: "synthetic_connector",
            title: "Synthetic Connector",
            auth: {
              kind: "oauth2",
              authorizationUrl: "https://example.test/authorize",
              tokenUrl: "https://example.test/token",
              scopes: [],
              authorizationParams: {},
              sendScope: true,
            },
            sync: {
              supportsIncremental: false,
              defaultFrequencyMinutes: 60,
              resources: [],
            },
            actions: [],
            configSchema: {},
          },
        ],
      },
    },
  } as unknown as DiscoveredCapabilityRecord;
}

function webProviderRecord(): DiscoveredCapabilityRecord {
  return createSyntheticCapabilityRecord({
    jobName: null,
    hostServices: ["web_provider"],
  }) as unknown as DiscoveredCapabilityRecord;
}

test("the host environment exposes the base URL and reads process env by name", () => {
  const env = createCapabilityHostEnvironment();
  process.env.SYNTHETIC_CAPABILITY_SECRET = "  from-env  ";

  assert.equal(typeof env.baseUrl, "string");
  assert.equal(env.get("SYNTHETIC_CAPABILITY_SECRET"), "  from-env  ");
  assert.equal(env.get("SYNTHETIC_CAPABILITY_ABSENT"), undefined);

  delete process.env.SYNTHETIC_CAPABILITY_SECRET;
});

test("connector adapters are collected from capabilities that declare connectors", async () => {
  const adapter = { capabilityId: "synthetic" };
  const contribution = await collectCapabilityConnectorContributions({
    recordsProvider: async () => [connectorRecord()],
    loadModule: async () => ({
      createConnectorAdapters: () => ({
        adapters: [adapter],
        agentToolDefs: syntheticConnectorAgentToolDefs,
      }),
    }),
  });

  assert.deepEqual(contribution.adapters, [adapter]);
  assert.deepEqual(
    contribution.agentToolDefs.map((def) => def.name),
    syntheticConnectorAgentToolDefs.map((def) => def.name),
  );
});

test("a capability that declares no connector is never asked for adapters", async () => {
  let loaded = 0;
  const contribution = await collectCapabilityConnectorContributions({
    recordsProvider: async () => [
      createSyntheticCapabilityRecord() as unknown as DiscoveredCapabilityRecord,
    ],
    loadModule: async () => {
      loaded += 1;
      return {};
    },
  });

  assert.equal(loaded, 0);
  assert.deepEqual(contribution.adapters, []);
  assert.deepEqual(contribution.agentToolDefs, []);
});

test("a declared connector whose module exports no factory is skipped, not fatal", async () => {
  const contribution = await collectCapabilityConnectorContributions({
    recordsProvider: async () => [connectorRecord()],
    loadModule: async () => ({}),
  });

  assert.deepEqual(contribution.adapters, []);
});

test("the web provider comes from the capability declaring the host service", async () => {
  const provider = { name: SYNTHETIC_CONNECTOR_TYPE };
  const resolved = await resolveCapabilityWebProvider(
    { fetchTimeoutMs: 1234 },
    {
      recordsProvider: async () => [webProviderRecord()],
      loadModule: async () => ({
        createHostWebProvider: (input: { fetchTimeoutMs?: number }) => {
          assert.equal(input.fetchTimeoutMs, 1234);
          return provider;
        },
      }),
    },
  );

  assert.equal(resolved, provider);
});

test("no declaring capability means no web provider, which is not an error", async () => {
  const resolved = await resolveCapabilityWebProvider(undefined, {
    recordsProvider: async () => [
      createSyntheticCapabilityRecord() as unknown as DiscoveredCapabilityRecord,
    ],
    loadModule: async () => ({
      createHostWebProvider: () => ({ name: "should-not-be-used" }),
    }),
  });

  assert.equal(resolved, null);
});

test("an unconfigured provider returning null leaves the host without web access", async () => {
  const resolved = await resolveCapabilityWebProvider(undefined, {
    recordsProvider: async () => [webProviderRecord()],
    loadModule: async () => ({ createHostWebProvider: () => null }),
  });

  assert.equal(resolved, null);
});

test("the first declaring capability wins when two answer the same port", async () => {
  const first = { name: "first" };
  const second = { name: "second" };
  const providers = [first, second];
  let index = 0;

  const resolved = await resolveCapabilityWebProvider(undefined, {
    recordsProvider: async () => [webProviderRecord(), webProviderRecord()],
    loadModule: async () => ({
      createHostWebProvider: () => providers[index++] ?? null,
    }),
  });

  assert.equal(resolved, first);
});
