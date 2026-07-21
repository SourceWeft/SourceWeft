import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import type { SandboxProviderFactory } from "@sourceweft/builtin-tool-sandbox";
import {
  createSyntheticCapabilityRecord,
  createSyntheticSandboxProviderFactory,
  createSyntheticSandboxProviderRecord,
  SYNTHETIC_SANDBOX_PROVIDER_ID,
} from "../../../../test/synthetic-capability";

/**
 * The sandbox provider registry as a socket.
 *
 * Every provider here is synthetic. That is the assertion: nothing in
 * `apps/backend/src` names Daytona any more, so a provider that this repo has
 * never heard of can be plugged in through the same capability path and
 * selected by id. If these tests needed the real Daytona package installed to
 * pass, the registry would still be soldered to it.
 */

type Registry = typeof import("./provider-registry");

/**
 * The registry memoises discovery per module instance, which is the behaviour
 * under test — so each test gets its own module instance rather than a reset
 * hook that would have to reach into that state.
 */
async function freshRegistry(): Promise<Registry> {
  vi.resetModules();
  return import("./provider-registry");
}

function record(capabilityId: string): DiscoveredCapabilityRecord {
  return createSyntheticSandboxProviderRecord({
    capabilityId,
  }) as unknown as DiscoveredCapabilityRecord;
}

function supplying(
  factoriesByCapability: Record<string, readonly SandboxProviderFactory[]>,
) {
  return {
    recordsProvider: async () => Object.keys(factoriesByCapability).map(record),
    loadModule: async (loaded: DiscoveredCapabilityRecord) => ({
      createSandboxProviderFactories: () =>
        factoriesByCapability[loaded.manifest.id] ?? [],
    }),
  };
}

describe("sandbox provider registry", () => {
  let registry: Registry;

  beforeEach(async () => {
    registry = await freshRegistry();
  });

  test("a provider the host has never heard of resolves once its capability declares it", async () => {
    const synthetic = createSyntheticSandboxProviderFactory();
    await registry.initializeSandboxProviderRegistry(
      supplying({
        "sourceweft-test/synthetic": [synthetic],
      }),
    );

    const resolved = registry.getSandboxProviderFactory(
      SYNTHETIC_SANDBOX_PROVIDER_ID,
    );
    assert.equal(resolved, synthetic);
    assert.equal(resolved?.getConfigurationStatus().configured, true);
  });

  test("two capabilities can each supply a provider and both stay selectable", async () => {
    const first = createSyntheticSandboxProviderFactory({ id: "provider-one" });
    const second = createSyntheticSandboxProviderFactory({ id: "provider-two" });
    await registry.initializeSandboxProviderRegistry(
      supplying({
        "sourceweft-test/one": [first],
        "sourceweft-test/two": [second],
      }),
    );

    assert.equal(registry.getSandboxProviderFactory("provider-one"), first);
    assert.equal(registry.getSandboxProviderFactory("provider-two"), second);
  });

  test("two capabilities claiming one provider id is a loud failure, not a silent shadow", async () => {
    const first = createSyntheticSandboxProviderFactory();
    const second = createSyntheticSandboxProviderFactory();

    await assert.rejects(
      registry.initializeSandboxProviderRegistry(
        supplying({
          "sourceweft-test/one": [first],
          "sourceweft-test/two": [second],
        }),
      ),
      (error: Error) => {
        assert.equal(error.name, "DuplicateSandboxProviderIdError");
        assert.match(error.message, /sourceweft-test\/one/u);
        assert.match(error.message, /sourceweft-test\/two/u);
        assert.match(error.message, new RegExp(SYNTHETIC_SANDBOX_PROVIDER_ID));
        return true;
      },
    );
  });

  test("an unknown provider id is null, which the sandbox service reports as unavailable", async () => {
    await registry.initializeSandboxProviderRegistry(
      supplying({
        "sourceweft-test/synthetic": [createSyntheticSandboxProviderFactory()],
      }),
    );

    assert.equal(registry.getSandboxProviderFactory("no-such-provider"), null);
  });

  test("a capability that declares no sandbox provider is never asked for one", async () => {
    let loaded = 0;
    await registry.initializeSandboxProviderRegistry({
      recordsProvider: async () => [
        createSyntheticCapabilityRecord() as unknown as DiscoveredCapabilityRecord,
      ],
      loadModule: async () => {
        loaded += 1;
        return {};
      },
    });

    assert.equal(loaded, 0);
    assert.equal(
      registry.getSandboxProviderFactory(SYNTHETIC_SANDBOX_PROVIDER_ID),
      null,
    );
  });

  test("a declaring capability whose module exports no factory is skipped, not fatal", async () => {
    await registry.initializeSandboxProviderRegistry({
      recordsProvider: async () => [record("sourceweft-test/synthetic")],
      loadModule: async () => ({}),
    });

    assert.equal(
      registry.getSandboxProviderFactory(SYNTHETIC_SANDBOX_PROVIDER_ID),
      null,
    );
  });

  test("looking up before discovery finished throws instead of reading as uninstalled", () => {
    assert.throws(
      () => registry.getSandboxProviderFactory(SYNTHETIC_SANDBOX_PROVIDER_ID),
      /before the provider registry finished/u,
    );
  });

  test("initialization is memoised, so every caller may await it unconditionally", async () => {
    let discoveries = 0;
    const sources = {
      recordsProvider: async () => {
        discoveries += 1;
        return [record("sourceweft-test/synthetic")];
      },
      loadModule: async () => ({
        createSandboxProviderFactories: () => [
          createSyntheticSandboxProviderFactory(),
        ],
      }),
    };

    await registry.initializeSandboxProviderRegistry(sources);
    await registry.initializeSandboxProviderRegistry(sources);
    await registry.initializeSandboxProviderRegistry(sources);

    assert.equal(discoveries, 1);
  });

  test("a failed discovery is not cached, so the next caller retries", async () => {
    let attempts = 0;
    const sources = {
      recordsProvider: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient discovery failure");
        }
        return [record("sourceweft-test/synthetic")];
      },
      loadModule: async () => ({
        createSandboxProviderFactories: () => [
          createSyntheticSandboxProviderFactory(),
        ],
      }),
    };

    await assert.rejects(
      registry.initializeSandboxProviderRegistry(sources),
      /transient discovery failure/u,
    );
    await registry.initializeSandboxProviderRegistry(sources);

    assert.equal(attempts, 2);
    assert.ok(
      registry.getSandboxProviderFactory(SYNTHETIC_SANDBOX_PROVIDER_ID),
    );
  });
});
