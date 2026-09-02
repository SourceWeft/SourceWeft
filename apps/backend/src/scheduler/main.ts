import { config } from "../shared/config";
import { logger } from "../shared/logger";
import {
  modelCatalog,
  syncGlobalModelGatewayConfig,
} from "../shared/model-gateway/index";
import { closeQueue } from "../shared/queue";
import { opsAlertService } from "../modules/ops";
import { durableChatRunService } from "../modules/threads";
import { agentSandboxService } from "../modules/threads";
import { scheduleConnectorSyncs } from "./schedules/connectors";
import { scheduleMarketFederation } from "./schedules/market-federation";
import { reconcileTeamSubscriptionsSchedule } from "./schedules/reconcile-team-subscriptions";
import { scheduleSyncModelPricing } from "./schedules/sync-model-pricing";

await syncGlobalModelGatewayConfig();
modelCatalog.startAutoRefresh(config.modelCatalogRefreshIntervalMs);

let tickInFlight = false;

async function tick() {
  if (tickInFlight) {
    logger.warn(
      "Scheduler tick skipped because previous tick is still running",
    );
    return;
  }

  tickInFlight = true;
  try {
    const jobs: Array<Promise<unknown>> = [];

    if (config.billing.teamBillingEnabled && config.billing.reconcileEnabled) {
      jobs.push(reconcileTeamSubscriptionsSchedule());
    }

    jobs.push(scheduleConnectorSyncs());
    jobs.push(durableChatRunService.expireWaitingApprovals());
    jobs.push(agentSandboxService.cleanupExpiredSandboxes());
    jobs.push(agentSandboxService.cleanupStaleSandboxOperations());

    if (jobs.length === 0) {
      return;
    }

    const settled = await Promise.allSettled(jobs);
    for (const item of settled) {
      if (item.status === "rejected") {
        const message =
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason);
        logger.error("Scheduler task failed", { message });

        try {
          await opsAlertService.trigger({
            alertKey: "scheduler:tick:failure",
            level: "error",
            source: "scheduler",
            title: "Scheduler tick failure",
            message,
            metadata: {
              intervalMs: config.schedulerIntervalMs,
            },
          });
        } catch (alertError) {
          logger.error("Failed to emit scheduler failure alert", {
            message,
            error:
              alertError instanceof Error
                ? alertError.message
                : String(alertError),
          });
        }
      }
    }
  } finally {
    tickInFlight = false;
  }
}

async function scheduleModelPricingSyncTick() {
  try {
    await scheduleSyncModelPricing();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to schedule model pricing sync job", { message });
  }
}

async function marketFederationTick() {
  if (!config.market.enabled) {
    return;
  }
  try {
    await scheduleMarketFederation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to run market federation sync", { message });
  }
}

void tick();
const timer = setInterval(() => {
  void tick();
}, config.schedulerIntervalMs);

const modelPricingSyncTimer = setInterval(() => {
  void scheduleModelPricingSyncTick();
}, config.modelPricingSyncIntervalMs);

void marketFederationTick();
const marketFederationTimer = setInterval(() => {
  void marketFederationTick();
}, config.market.federationIntervalMs);

logger.info("Scheduler started", {
  intervalMs: config.schedulerIntervalMs,
  modelPricingSyncIntervalMs: config.modelPricingSyncIntervalMs,
  billingReconcileEnabled:
    config.billing.teamBillingEnabled && config.billing.reconcileEnabled,
});
void agentSandboxService.logStartupWarning("scheduler");

async function shutdown() {
  clearInterval(timer);
  clearInterval(modelPricingSyncTimer);
  clearInterval(marketFederationTimer);
  logger.info("Scheduler shutting down");
  await closeQueue();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
