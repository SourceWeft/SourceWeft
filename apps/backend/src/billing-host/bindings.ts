import "dotenv/config";
import { resolveCommercialEnabled } from "./config";

// Resolve once, before Auth/API/worker/scheduler consumers initialize. A failed
// commercial import or configuration is fatal; it never selects disabled mode.
const implementation = resolveCommercialEnabled(process.env)
  ? await import("./commercial")
  : await import("./disabled");

export const {
  billingRuntime,
  billingOrganizationHooks,
  getBillingDeploymentCapabilities,
  billingSchedulesEnabled,
  getBillingAuthPlugins,
  handleBillingAuthRequest,
  registerBillingHttpRoutes,
  reconcileBillingSchedule,
  runBillingCatalogCheck,
  validateBillingStartup,
} = implementation;
