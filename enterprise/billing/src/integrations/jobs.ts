import type { BillingService } from "../server/service";
import type { BillingAlertSink, BillingLogger } from "../server/host";
export function createBillingSchedule(
  billingService: BillingService,
  opsAlertService: BillingAlertSink,
  logger: BillingLogger,
) {
  return async function reconcileTeamSubscriptionsSchedule() {
    const [result, orderResult] = await Promise.all([
      billingService.reconcileTeamSubscriptions(),
      billingService.reconcileBillingOrders(),
    ]);

    if (result.realigned === 0 && orderResult.failed === 0) {
      logger.info("Billing reconcile completed", {
        checked: result.checked,
        realigned: 0,
        orderChecked: orderResult.checked,
        orderRetried: orderResult.retried,
      });
      return result;
    }

    logger.warn("Billing reconcile realigned team plans", {
      checked: result.checked,
      realigned: result.realigned,
      orderChecked: orderResult.checked,
      orderRetried: orderResult.retried,
      orderFailed: orderResult.failed,
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
  };
}
