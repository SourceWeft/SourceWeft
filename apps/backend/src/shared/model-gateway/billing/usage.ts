/**
 * Summing of provider usage across calls.
 *
 * Lives in the billing module rather than the agent turn because the billing
 * scope is now the thing that aggregates usage, and `shared/` must not depend
 * on `modules/`.
 */
import type { UsageInfo } from "@sourceweft/model-gateway";

export function addUsage(
  current: UsageInfo | undefined,
  next: UsageInfo | undefined,
): UsageInfo | undefined {
  if (!next) {
    return current;
  }

  const sum = (left?: number, right?: number) =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  const costDetails = {
    ...(current?.costDetails ?? {}),
    ...(next.costDetails ?? {}),
  };

  return {
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    totalTokens: sum(current?.totalTokens, next.totalTokens),
    cacheReadTokens: sum(current?.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(current?.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: sum(current?.reasoningTokens, next.reasoningTokens),
    inputImageTokens: sum(current?.inputImageTokens, next.inputImageTokens),
    outputImageTokens: sum(current?.outputImageTokens, next.outputImageTokens),
    inputImageCount: sum(current?.inputImageCount, next.inputImageCount),
    outputImageCount: sum(current?.outputImageCount, next.outputImageCount),
    inputAudioTokens: sum(current?.inputAudioTokens, next.inputAudioTokens),
    outputAudioTokens: sum(current?.outputAudioTokens, next.outputAudioTokens),
    providerCostUsd: sum(current?.providerCostUsd, next.providerCostUsd),
    providerCostSource: next.providerCostSource ?? current?.providerCostSource,
    costDetails: Object.keys(costDetails).length > 0 ? costDetails : undefined,
  };
}
