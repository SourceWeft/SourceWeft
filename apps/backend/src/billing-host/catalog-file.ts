import {
  readBillingCatalogFile,
  type LoadedBillingCatalog,
} from "@sourceweft/billing/billing-catalog";
import { resolveBackendRuntimePath } from "../shared/runtime-paths";

/**
 * The billing catalog lives next to the billing package and is found by its
 * fixed path. A deployment overrides it by mounting its own file over that path.
 */
export function loadBillingCatalog(): LoadedBillingCatalog {
  const filePath = resolveBackendRuntimePath({
    candidates: ["../../enterprise/billing/config/billing-catalog.json"],
    label: "billing catalog",
  });
  return readBillingCatalogFile(filePath);
}
