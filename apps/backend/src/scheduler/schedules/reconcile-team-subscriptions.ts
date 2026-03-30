import { billingService } from "../../modules/billing";
import { opsAlertService } from "../../modules/ops";
import { logger } from "../../shared/logger";

export async function reconcileTeamSubscriptionsSchedule() {
  const result = await billingService.reconcileTeamSubscriptions();

  if (result.realigned === 0) {
    logger.info("Billing reconcile completed", {
      checked: result.checked,
      realigned: 0,
    });
    return result;
  }

  logger.warn("Billing reconcile realigned team plans", {
    checked: result.checked,
    realigned: result.realigned,
  });

  for (const anomaly of result.anomalies) {
    try {
      await opsAlertService.trigger({
        alertKey: `billing:reconcile:plan-mismatch:${anomaly.teamId}`,
        level: "warn",
        source: "billing.reconcile",
        title: "Team plan was auto-realigned",
        message: `Team ${anomaly.teamId} plan was realigned from ${anomaly.previousPlanFamily} to ${anomaly.expectedPlanFamily}`,
        teamId: anomaly.teamId,
        metadata: {
          previousPlanFamily: anomaly.previousPlanFamily,
          expectedPlanFamily: anomaly.expectedPlanFamily,
          subscriptionStatus: anomaly.subscriptionStatus,
          externalSubscriptionId: anomaly.externalSubscriptionId,
        },
      });
    } catch (error) {
      logger.error("Failed to emit reconcile anomaly alert", {
        teamId: anomaly.teamId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
