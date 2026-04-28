import { BillingAccountService } from "./account-service";
import type { BillingStore } from "./store-port";
import type {
  BillingRuntimeConfig,
  TeamPlanReconcileAnomaly,
  TeamPlanReconcileResult,
} from "./types";
import { resolvePlanFromSubscription } from "./service-helpers";

export class BillingReconcileService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly accountService: BillingAccountService,
  ) {}

  async reconcileTeamSubscriptions(): Promise<TeamPlanReconcileResult> {
    if (
      !this.runtimeConfig.teamBillingEnabled ||
      !this.runtimeConfig.reconcileEnabled
    ) {
      return {
        checked: 0,
        realigned: 0,
        anomalies: [],
      };
    }

    const states = await this.store.listAccountSubscriptionStates();
    const anomalies: TeamPlanReconcileAnomaly[] = [];
    let realigned = 0;

    for (const state of states) {
      const expectedFromState = resolvePlanFromSubscription({
        status: state.subscriptionStatus ?? "inactive",
        defaultPlanFamily: this.runtimeConfig.defaultPlanFamily,
      });

      if (state.accountPlanFamily === expectedFromState) {
        continue;
      }

      await this.accountService.withLockedAccount(
        state.teamId,
        async ({ account, client }) => {
          const latestSubscription = await this.store.getSubscriptionByTeam(
            account.teamId,
            client,
          );
          const expectedPlan = resolvePlanFromSubscription({
            status: latestSubscription?.status ?? "inactive",
            defaultPlanFamily: this.runtimeConfig.defaultPlanFamily,
          });

          if (account.planFamily === expectedPlan) {
            return;
          }

          const previousPlanFamily = account.planFamily;
          await this.accountService.applyPlanFamilyLocked(
            account,
            expectedPlan,
            client,
            {
              source: "reconcile",
              reason: "plan_mismatch",
              previousPlanFamily,
              expectedPlanFamily: expectedPlan,
              subscriptionStatus: latestSubscription?.status ?? "inactive",
            },
          );

          realigned += 1;
          anomalies.push({
            teamId: account.teamId,
            previousPlanFamily,
            expectedPlanFamily: expectedPlan,
            subscriptionStatus: latestSubscription?.status ?? "inactive",
            externalSubscriptionId:
              latestSubscription?.externalSubscriptionId ?? null,
          });
        },
      );
    }

    return {
      checked: states.length,
      realigned,
      anomalies,
    };
  }
}
