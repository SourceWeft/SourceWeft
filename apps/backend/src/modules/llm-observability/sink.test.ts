import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ObserveGenerationEnd } from "@sourceweft/model-gateway";

const mockFindWorkspaceInOrg = vi.fn();
const mockEndGeneration = vi.fn();
const mockStartGeneration = vi.fn();
const mockRecordGenerationError = vi.fn();

vi.mock("@sourceweft/db", () => ({
  db: {},
  llmGenerations: {},
}));

vi.mock("../workspace", () => ({
  workspaceService: {
    findWorkspaceInOrganization: (...a: unknown[]) =>
      mockFindWorkspaceInOrg(...a),
  },
}));

vi.mock("../../shared/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock(".", () => ({
  endGeneration: (...a: unknown[]) => mockEndGeneration(...a),
  startGeneration: (...a: unknown[]) => mockStartGeneration(...a),
  recordGenerationError: (...a: unknown[]) => mockRecordGenerationError(...a),
}));

const { createLlmObservabilitySink } = await import("./sink");

beforeEach(() => {
  vi.clearAllMocks();
  mockFindWorkspaceInOrg.mockResolvedValue({ id: "workspace-1" });
});

function baseGeneration(
  overrides: Partial<ObserveGenerationEnd> = {},
): ObserveGenerationEnd {
  return {
    spanId: "span-1",
    traceId: "trace-1",
    endedAt: new Date().toISOString(),
    attributes: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      gatewayConfigId: "gateway-1",
      profileAlias: "chat-default",
      modelKind: "chat",
    },
    ...overrides,
  };
}

test("falls through to the price-book resolver when the observed cost has no effectiveUsd", async () => {
  // Mirrors the OrcaRouter adapter's placeholder cost: present (truthy) but
  // carrying no settled/inline figure yet, pending async receipt reconciliation.
  const resolveCost = vi.fn().mockResolvedValue({
    providerCostUsd: 0.0042,
    costSource: "price_book",
  });

  const sink = createLlmObservabilitySink({ resolveCost });
  await sink.onGenerationEnd?.(
    baseGeneration({
      observation: {
        identity: {
          modelAlias: "chat-default",
          provider: "orcarouter",
          requestedProviderModel: "qwen/qwen3.7-plus",
        },
        cost: {
          currency: "USD",
          source: "missing",
          status: "pending",
        },
        provenance: {},
      },
    }),
  );

  assert.equal(resolveCost.mock.calls.length, 1);
  assert.equal(mockEndGeneration.mock.calls.length, 1);
  const call = mockEndGeneration.mock.calls[0]?.[0];
  assert.ok(call);
  assert.equal(call.providerCostUsd, 0.0042);
  assert.equal(call.metadata.costSource, "price_book");
});

test("uses the observed cost directly when it already carries an effectiveUsd", async () => {
  const resolveCost = vi.fn().mockResolvedValue({
    providerCostUsd: 999,
    costSource: "price_book",
  });

  const sink = createLlmObservabilitySink({ resolveCost });
  await sink.onGenerationEnd?.(
    baseGeneration({
      observation: {
        identity: {
          modelAlias: "chat-default",
          provider: "openrouter",
          requestedProviderModel: "openai/gpt-5",
        },
        cost: {
          currency: "USD",
          inlineUsd: 0.0123,
          effectiveUsd: 0.0123,
          source: "provider_inline",
          status: "inline",
        },
        provenance: {},
      },
    }),
  );

  assert.equal(resolveCost.mock.calls.length, 0);
  assert.equal(mockEndGeneration.mock.calls.length, 1);
  const call = mockEndGeneration.mock.calls[0]?.[0];
  assert.ok(call);
  assert.equal(call.providerCostUsd, 0.0123);
  assert.equal(call.metadata.costSource, "provider_inline");
});
