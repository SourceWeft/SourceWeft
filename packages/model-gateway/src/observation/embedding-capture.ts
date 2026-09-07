import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedRequestTarget, UsageInfo } from "../types";
import type { ModelCallObservation } from "./types";

const MAX_REQUEST_ID_BYTES = 256;
const MAX_REQUEST_IDS_BYTES = 16 * 1024;

type TokenCounter = { total?: number; missing: number };
export type EmbeddingResponseCapture = {
  active: boolean;
  batches: number;
  inputTokens: TokenCounter;
  totalTokens: TokenCounter;
  requestIds: string[];
  requestIdBytes: number;
  omittedIds: number;
  missingIds: number;
};
const storage = new AsyncLocalStorage<EmbeddingResponseCapture>();

export function createEmbeddingResponseCapture(): EmbeddingResponseCapture {
  return {
    active: true,
    batches: 0,
    inputTokens: { missing: 0 },
    totalTokens: { missing: 0 },
    requestIds: [],
    requestIdBytes: 0,
    omittedIds: 0,
    missingIds: 0,
  };
}

export function runWithEmbeddingResponseCapture<T>(
  capture: EmbeddingResponseCapture,
  run: () => T,
): T {
  return storage.run(capture, run);
}

function addTokens(counter: TokenCounter, value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    counter.missing++;
    return;
  }
  const sum = (counter.total ?? 0) + value;
  if (!Number.isSafeInteger(sum)) {
    counter.missing++;
    return;
  }
  counter.total = sum;
}

/** Only SDK-declared scalar fields cross this boundary; never retain vectors. */
export function captureEmbeddingResponse(input: {
  inputTokens: unknown;
  totalTokens: unknown;
  requestId: unknown;
}) {
  const capture = storage.getStore();
  if (!capture?.active) return;
  capture.batches++;
  addTokens(capture.inputTokens, input.inputTokens);
  addTokens(capture.totalTokens, input.totalTokens);
  const id = input.requestId;
  if (typeof id !== "string" || id.length === 0) {
    capture.missingIds++;
    return;
  }
  const bytes = Buffer.byteLength(id, "utf8");
  if (
    bytes > MAX_REQUEST_ID_BYTES ||
    capture.requestIdBytes + bytes > MAX_REQUEST_IDS_BYTES
  ) {
    capture.omittedIds++;
    return;
  }
  capture.requestIds.push(id);
  capture.requestIdBytes += bytes;
}

export function finishEmbeddingResponseCapture(input: {
  capture: EmbeddingResponseCapture;
  target: ResolvedRequestTarget;
  modelAlias: string;
  failed: boolean;
}): ModelCallObservation {
  const { capture } = input;
  // Promise.all can reject while other SDK batches remain in flight. Their
  // eventual responses must not mutate this attempt or its emitted snapshot.
  capture.active = false;
  const usage: UsageInfo = {
    ...(capture.inputTokens.total !== undefined
      ? { inputTokens: capture.inputTokens.total }
      : {}),
    ...(capture.totalTokens.total !== undefined
      ? { totalTokens: capture.totalTokens.total }
      : {}),
  };
  const diagnostics: NonNullable<ModelCallObservation["diagnostics"]> = [];
  if (capture.batches === 0) {
    diagnostics.push({
      code: "EMBEDDING_USAGE_UNAVAILABLE",
      message: "No SDK embedding response usage was captured",
    });
  }
  for (const field of ["inputTokens", "totalTokens"] as const) {
    if (capture[field].missing > 0)
      diagnostics.push({
        code: "EMBEDDING_USAGE_INCOMPLETE",
        field,
        omittedCount: capture[field].missing,
        message:
          "Usage includes only successful batches with valid reported token counts",
      });
  }
  if (input.failed && capture.batches > 0)
    diagnostics.push({
      code: "EMBEDDING_BATCH_INCOMPLETE",
      message:
        "Embedding failed; usage includes only batches completed before termination",
    });
  if (capture.omittedIds > 0)
    diagnostics.push({
      code: "IDENTITY_TRUNCATED",
      omittedCount: capture.omittedIds,
      message:
        "Request IDs exceeding the per-ID or per-call byte limit were omitted",
    });
  if (capture.missingIds > 0)
    diagnostics.push({
      code: "EMBEDDING_REQUEST_ID_UNAVAILABLE",
      omittedCount: capture.missingIds,
      message: "Some successful embedding batches did not report a request ID",
    });
  return {
    identity: {
      modelAlias: input.modelAlias,
      provider: input.target.provider,
      requestedProviderModel: input.target.providerModel,
      ...(capture.batches === 1 && capture.requestIds.length === 1
        ? { providerRequestId: capture.requestIds[0] }
        : {}),
      ...(capture.requestIds.length > 0
        ? { providerRequestIds: [...capture.requestIds] }
        : {}),
    },
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    provenance:
      Object.keys(usage).length > 0
        ? { usage: "protocol:openai-compatible.embedding_responses" }
        : {},
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  };
}
