import type { ProviderResponseAdapter } from "../../../observation/types";
import { reconcileOrcaRouterCost } from "./receipt";
import { decorateOrcaRouterRequest } from "./request";
import {
  normalizeOrcaRouterResponse,
  selectOrcaRouterResponseHeaders,
} from "./response";

export const orcaRouterProviderAdapter: ProviderResponseAdapter = {
  decorateRequest: decorateOrcaRouterRequest,
  selectResponseHeaders: selectOrcaRouterResponseHeaders,
  normalizeResponse: (context) => normalizeOrcaRouterResponse(context),
  reconcileCost: reconcileOrcaRouterCost,
  costCapabilities: {
    actualCostMode: "inline_and_receipt",
    allowPriceBookFallback: false,
  },
};
