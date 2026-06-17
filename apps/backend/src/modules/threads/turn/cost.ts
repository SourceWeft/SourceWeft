// Backward-compatible re-export.  The canonical implementations live in
// ../../content/provider-cost.ts — that module is the shared kernel for
// provider cost computation and has no dependency on threads/ internals.

import { computeProviderCostFromPricing } from "../../content/provider-cost";

export {
  computeProviderCost,
  computeProviderCostFromPricing,
  type ProviderCostResult,
} from "../../content/provider-cost";

export const testExports = {
  computeProviderCostFromPricing,
};
