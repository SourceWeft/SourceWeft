import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import type { SandboxProviderFactory } from "@sourceweft/builtin-tool-sandbox";

vi.mock("@sourceweft/sandbox-provider-daytona", () => ({
  createDaytonaSandboxProviderFactory: vi.fn(
    (_config: {
      apiKey: string;
      apiUrl?: string;
      snapshot?: string;
      image?: string;
      maxOutputChars: number;
    }) =>
      ({
        id: "daytona",
        createProvider: () => {
          throw new Error("not implemented in test");
        },
        getConfigurationStatus: () => ({
          configured: true,
          missing: [],
          metadata: { defaultSandboxEnvironmentAvailable: true },
        }),
      }) as SandboxProviderFactory,
  ),
}));

vi.mock("../../../../shared/config", () => ({
  config: {
    sandbox: {
      daytona: {
        apiUrl: "http://test-daytona",
        apiKey: "test-key",
        snapshot: "test-snapshot",
        image: "",
      },
      maxOutputChars: 10000,
    },
  },
}));

describe("provider-registry", () => {
  let mod: typeof import("./provider-registry");

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("./provider-registry");
  });

  test('getSandboxProviderFactory("daytona") returns the built-in factory', () => {
    const factory = mod.getSandboxProviderFactory("daytona");
    assert.ok(factory);
    assert.equal(factory!.id, "daytona");
  });

  test('getSandboxProviderFactory("unknown") returns null', () => {
    const factory = mod.getSandboxProviderFactory("unknown");
    assert.equal(factory, null);
  });

  test("listSandboxProviderFactories() returns registered factories", () => {
    const factories = mod.listSandboxProviderFactories();
    assert.equal(factories.length, 1);
    assert.equal(factories[0]!.id, "daytona");
  });

  test("registerSandboxProviderFactory() with duplicate ID throws", () => {
    const duplicate: SandboxProviderFactory = {
      id: "daytona",
      createProvider: () => {
        throw new Error("not implemented in test");
      },
      getConfigurationStatus: () => ({ configured: true, missing: [] }),
    };
    assert.throws(
      () => mod.registerSandboxProviderFactory(duplicate),
      /already registered/u,
    );
  });
});
