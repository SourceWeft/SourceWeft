import { validateBillingStartup } from "../billing-host/bindings";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import {
  modelCatalog,
  syncGlobalModelGatewayConfigAtStartup,
} from "../shared/model-gateway/index";
import { closeQueue } from "../shared/queue";
import { opsAlertService } from "../modules/ops";
import { durableChatRunService } from "../modules/threads";
import { agentSandboxService } from "../modules/threads";
import { contentSourceService } from "../modules/sources";
import { scheduleConnectorSyncs } from "./schedules/connectors";
import { scheduleMarketFederation } from "./schedules/market-federation";
import {
  MCP_README_SCHEDULE_INTERVAL_MS,
  scheduleMcpReadmeFetches,
} from "./schedules/mcp-readme";
import {
  scheduleSkillMarketUpkeep,
  SKILL_MARKET_INTERVAL_MS,
} from "./schedules/skill-market";
import {
  reconcileBillingSchedule as reconcileTeamSubscriptionsSchedule,
  billingSchedulesEnabled,
} from "../billing-host/bindings";
import { scheduleSyncModelPricing } from "./schedules/sync-model-pricing";
import { startServiceHeartbeat } from "../shared/service-heartbeat";

validateBillingStartup();
await syncGlobalModelGatewayConfigAtStartup();
modelCatalog.startAutoRefresh(config.modelCatalogRefreshIntervalMs);

let tickInFlight = false;
let tickStartedAt = 0;
// A tick that has not returned in this long is stuck; the scheduler then stops
// reporting healthy (see the heartbeat below).
const STUCK_TICK_MS = 10 * 60_000;

async function tick() {
  if (tickInFlight) {
    logger.warn(
      "Scheduler tick skipped because previous tick is still running",
    );
    return;
  }

  tickInFlight = true;
  tickStartedAt = Date.now();
  try {
    const jobs: Array<Promise<unknown>> = [];

    if (billingSchedulesEnabled) {
      jobs.push(reconcileTeamSubscriptionsSchedule());
    }

    jobs.push(scheduleConnectorSyncs());
    jobs.push(durableChatRunService.expireWaitingApprovals());
    jobs.push(durableChatRunService.failStaleActiveRuns());
    jobs.push(agentSandboxService.cleanupExpiredSandboxes());
    jobs.push(agentSandboxService.cleanupStaleSandboxOperations());
    // Direct uploads have no request to fail when a client walks away, so the
    // reserved rows are reconciled here instead of in a catch block.
    jobs.push(contentSourceService.failStaleSourceUploads());

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

// The MCP catalog's README queue runs on its own, shorter interval than the
// federation sync: a batch at a time, so the catalog is covered in hours
// rather than one batch per federation run.
async function mcpReadmeTick() {
  if (!config.market.enabled) {
    return;
  }
  try {
    await scheduleMcpReadmeFetches();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to queue MCP README fetches", { message });
  }
}

async function skillMarketTick() {
  if (!config.market.enabled) {
    return;
  }
  try {
    await scheduleSkillMarketUpkeep();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to run skill market upkeep", { message });
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

void mcpReadmeTick();
const mcpReadmeTimer = setInterval(() => {
  void mcpReadmeTick();
}, MCP_README_SCHEDULE_INTERVAL_MS);

void skillMarketTick();
const skillMarketTimer = setInterval(() => {
  void mcpReadmeTick();
  const mcpReadmeTimer = setInterval(() => {
    void mcpReadmeTick();
  }, MCP_README_SCHEDULE_INTERVAL_MS);

  void skillMarketTick();
}, SKILL_MARKET_INTERVAL_MS);

// Liveness for `launch.js health scheduler`: the event loop runs this timer
// and no tick is stuck. A tick that is slow because a dependency is down still
// ends within STUCK_TICK_MS through its own timeouts.
const heartbeat = startServiceHeartbeat({
  service: "scheduler",
  isHealthy: () => !tickInFlight || Date.now() - tickStartedAt < STUCK_TICK_MS,
});

logger.info("Scheduler started", {
  intervalMs: config.schedulerIntervalMs,
  modelPricingSyncIntervalMs: config.modelPricingSyncIntervalMs,
  billingReconcileEnabled: billingSchedulesEnabled,
});
void agentSandboxService.logStartupWarning("scheduler");

async function shutdown() {
  heartbeat.stop();
  clearInterval(timer);
  clearInterval(modelPricingSyncTimer);
  clearInterval(marketFederationTimer);
  clearInterval(mcpReadmeTimer);
  clearInterval(skillMarketTimer);
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
