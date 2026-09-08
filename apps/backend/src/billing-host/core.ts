import type {
  BillingOrganizationHooks,
  BillingRuntime,
} from "@sourceweft/contracts/billing-runtime";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";

/** Selected by the core edition binding, never by catching a commercial failure. */
export function createCoreBillingRuntime(): BillingRuntime {
  return {
    async getExecutionState() {
      return { kind: "unmetered", reason: "billing_not_installed" };
    },
    async settleModelUsage() {
      return { status: "skipped", reason: "billing_not_installed" };
    },
    async meterIngestion() {
      return { status: "skipped", reason: "billing_not_installed" };
    },
    async reconcileProviderCost() {
      return { status: "skipped", reason: "billing_not_installed" };
    },
  };
}

export function createCoreBillingOrganizationHooks(): BillingOrganizationHooks {
  return {
    async provisionAccount() {},
    async beforeAddMember() {},
    async beforeInviteMember() {},
    async beforeAcceptInvitation() {},
  };
}

export function coreDeploymentCapabilities(): DeploymentCapabilities {
  return {
    edition: "core",
    billingRuntimeApiVersion: 1,
    billing: {
      available: false,
      mode: null,
      checkout: false,
      teamSubscriptions: false,
      topup: false,
    },
  };
}
