import type { RetrievalCallTrace } from "./types";

export function summarizeRetrievalCalls(retrievalCalls: RetrievalCallTrace[]) {
  const totalHitCount = retrievalCalls.reduce(
    (sum, call) => sum + call.hitCount,
    0,
  );
  const totalLatencyMs = retrievalCalls.reduce(
    (sum, call) => sum + call.latencyMs,
    0,
  );
  const maxLatencyMs = retrievalCalls.reduce(
    (max, call) => (call.latencyMs > max ? call.latencyMs : max),
    0,
  );

  return {
    count: retrievalCalls.length,
    totalHitCount,
    totalLatencyMs,
    avgLatencyMs:
      retrievalCalls.length > 0
        ? Math.round(totalLatencyMs / retrievalCalls.length)
        : null,
    maxLatencyMs: retrievalCalls.length > 0 ? maxLatencyMs : null,
  };
}
