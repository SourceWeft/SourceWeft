import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ModelCallObservation,
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveSink,
  UsageInfo,
} from "@sourceweft/model-gateway";

export type UsageSlot = {
  usage?: UsageInfo;
  observation?: ModelCallObservation;
};
export const usageStorage = new AsyncLocalStorage<UsageSlot>();

export function resetCapturedUsage() {
  const slot = usageStorage.getStore();
  if (slot) {
    slot.usage = undefined;
    slot.observation = undefined;
  }
}

/** Transport only: attribution and settlement still belong to the billing scope. */
export function captureGenerationUsage(
  generation: Pick<
    ObserveGenerationEnd | ObserveGenerationError,
    "usage" | "observation"
  >,
) {
  const slot = usageStorage.getStore();
  if (!slot) return;
  const usage = generation.usage ?? generation.observation?.usage;
  if (usage !== undefined) slot.usage = usage;
  if (generation.observation !== undefined)
    slot.observation = generation.observation;
}

export function createUsageCaptureSink(): ObserveSink {
  return {
    onGenerationStart: resetCapturedUsage,
    onGenerationEnd: captureGenerationUsage,
    onGenerationError: captureGenerationUsage,
  };
}
