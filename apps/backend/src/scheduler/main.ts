import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { closeQueue } from "../shared/queue";
import { opsAlertService } from "../modules/ops";
import { scheduleExampleJob } from "./schedules/example-schedule";
import { reconcileTeamSubscriptionsSchedule } from "./schedules/reconcile-team-subscriptions";

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

void tick();
const timer = setInterval(() => {
  void tick();
}, config.schedulerIntervalMs);

logger.info("Scheduler started", {
  intervalMs: config.schedulerIntervalMs,
  exampleJobEnabled: config.schedulerExampleJobEnabled,
  billingReconcileEnabled:
    config.billing.teamBillingEnabled && config.billing.reconcileEnabled,
});

async function shutdown() {
  clearInterval(timer);
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
