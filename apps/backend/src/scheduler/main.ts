import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureModelConfigBootstrapped } from "../shared/model-gateway";
import { closeQueue } from "../shared/queue";
import { opsAlertService } from "../modules/ops";
import { scheduleExampleJob } from "./schedules/example-schedule";
import { reconcileTeamSubscriptionsSchedule } from "./schedules/reconcile-team-subscriptions";
import { scheduleSyncModelPricing } from "./schedules/sync-model-pricing";

const MODEL_PRICING_SYNC_INTERVAL_MS = 60 * 60 * 1000;

await ensureModelConfigBootstrapped();

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

    if (config.schedulerExampleJobEnabled) {
      jobs.push(scheduleExampleJob());
    }

    if (config.billing.teamBillingEnabled && config.billing.reconcileEnabled) {
      jobs.push(reconcileTeamSubscriptionsSchedule());
    }

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

void tick();
const timer = setInterval(() => {
  void tick();
}, config.schedulerIntervalMs);

void scheduleModelPricingSyncTick();
const modelPricingSyncTimer = setInterval(() => {
  void scheduleModelPricingSyncTick();
}, MODEL_PRICING_SYNC_INTERVAL_MS);

logger.info("Scheduler started", {
  intervalMs: config.schedulerIntervalMs,
  exampleJobEnabled: config.schedulerExampleJobEnabled,
  billingReconcileEnabled:
    config.billing.teamBillingEnabled && config.billing.reconcileEnabled,
});

async function shutdown() {
  clearInterval(timer);
  clearInterval(modelPricingSyncTimer);
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
