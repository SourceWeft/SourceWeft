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
const { applyPayloadPolicyToRecord } = await import("./payload-policy");

beforeEach(() => {
  vi.clearAllMocks();
  mockFindWorkspaceInOrg.mockResolvedValue({ id: "workspace-1" });
});

// A transcript string that must never reach any stored column for dictation.
const SECRET = "xyzzy-secret-transcript-should-never-be-stored";

// Mirrors writer.policyText / policyRecord: the exact JSON a column would hold
// for the given payload mode, so a test can assert what would be persisted.
function storedText(value: unknown, mode: unknown): string {
  const record = applyPayloadPolicyToRecord(
    value,
    mode as "metadata_only" | "preview" | "full" | undefined,
  );
  return record ? JSON.stringify(record) : "";
}
function storedRecord(value: unknown, mode: unknown): string {
  return JSON.stringify(
    applyPayloadPolicyToRecord(
      value,
      mode as "metadata_only" | "preview" | "full" | undefined,
    ) ?? null,
  );
}

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

test("a dictation generation stores metadata only: no transcript, no raw response", async () => {
  const sink = createLlmObservabilitySink();
  await sink.onGenerationEnd?.(
    baseGeneration({
      attributes: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        feature: "chat.dictation",
        gatewayConfigId: "gateway-1",
        profileAlias: "asr-dictation",
        modelKind: "asr",
      },
      outputText: SECRET,
      providerResponse: { text: SECRET, raw: { transcript: SECRET } },
    }),
  );

  assert.equal(mockEndGeneration.mock.calls.length, 1);
  const call = mockEndGeneration.mock.calls[0]?.[0];
  assert.ok(call);
  assert.equal(call.payloadMode, "metadata_only");
  // What the outputText and providerResponse columns would hold carries no
  // transcript and no raw provider response.
  assert.equal(storedText(call.outputText, call.payloadMode).includes(SECRET), false);
  assert.equal(
    storedRecord(call.providerResponse, call.payloadMode).includes(SECRET),
    false,
  );
});

test("dictation start and error also select metadata_only", async () => {
  const sink = createLlmObservabilitySink();
  const attributes = {
    teamId: "team-1",
    workspaceId: "workspace-1",
    feature: "chat.dictation",
    gatewayConfigId: "gateway-1",
    profileAlias: "asr-dictation",
    modelKind: "asr",
  };

  await sink.onGenerationStart?.({
    spanId: "span-1",
    traceId: "trace-1",
    startedAt: new Date().toISOString(),
    operation: "asr.transcribe",
    input: { transcript: SECRET },
    attributes,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await sink.onGenerationError?.({
    spanId: "span-1",
    traceId: "trace-1",
    endedAt: new Date().toISOString(),
    errorMessage: "boom",
    providerResponse: { text: SECRET },
    attributes,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  assert.equal(mockStartGeneration.mock.calls[0]?.[0].payloadMode, "metadata_only");
  assert.equal(
    mockRecordGenerationError.mock.calls[0]?.[0].payloadMode,
    "metadata_only",
  );
  const startCall = mockStartGeneration.mock.calls[0]?.[0];
  assert.equal(
    storedRecord(startCall.input, startCall.payloadMode).includes(SECRET),
    false,
  );
});

test("a non-dictation ASR generation is still stored as before", async () => {
  const sink = createLlmObservabilitySink();
  await sink.onGenerationEnd?.(
    baseGeneration({
      attributes: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        feature: "source_ingestion",
        gatewayConfigId: "gateway-1",
        profileAlias: "asr-default",
        modelKind: "asr",
      },
      outputText: SECRET,
      providerResponse: { text: SECRET },
    }),
  );

  const call = mockEndGeneration.mock.calls[0]?.[0];
  assert.ok(call);
  // Unchanged: no metadata-only override, and the text is still captured.
  assert.equal(call.payloadMode, undefined);
  assert.equal(storedText(call.outputText, call.payloadMode).includes(SECRET), true);
});
