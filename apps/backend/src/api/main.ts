import { validateBillingStartup } from "../billing-host/bindings";
import { serve } from "@hono/node-server";
import { config } from "../shared/config";
import { closeDatabase } from "@sourceweft/db";
import { logger } from "../shared/logger";
import {
  ensureModelConfigAvailable,
  modelCatalog,
  syncGlobalModelGatewayConfig,
} from "../shared/model-gateway/index";
import { closeQueue } from "../shared/queue";
import { notifyHub } from "../shared/notify-hub";
import { metrics } from "../shared/metrics";
import { createApp } from "./app";
import { contentSkillsService } from "../modules/skills";
import { agentSandboxService } from "../modules/threads";
import { connectorAdaptersReady } from "../modules/connectors";
import { attachLocalDeviceGateway } from "../modules/devices/gateway";

validateBillingStartup();
await syncGlobalModelGatewayConfig({ syncPricing: false });
modelCatalog.startAutoRefresh(config.modelCatalogRefreshIntervalMs);
await ensureModelConfigAvailable();
await contentSkillsService.syncBuiltinCatalog();
// Connectors are contributed by capabilities, so registering them reads
// manifests. Await it before serving so the registry is never consulted empty.
await connectorAdaptersReady();
// Live thread collaboration: start the LISTEN connection before serving so the
// first /room subscriber has a working fan-out. API process only — the worker
// and scheduler publish events but never hold SSE subscribers.
await notifyHub.start();
// Flush a metrics snapshot line periodically (API process only).
metrics.startPeriodicFlush();
const app = createApp();

const httpServer = serve(
  {
    fetch: app.fetch,
    hostname: config.apiHost,
    port: config.apiPort,
  },
  () => {
    logger.info("API server started", {
      host: config.apiHost,
      port: config.apiPort,
    });
    void agentSandboxService.logStartupWarning("api");
  },
);
const closeLocalGateway = attachLocalDeviceGateway(
  httpServer as import("node:http").Server,
);

async function shutdown() {
  closeLocalGateway();
  logger.info("API shutting down");
  metrics.stop();
  // Stop the hub (ends its dedicated LISTEN client) before closing the pool.
  await Promise.allSettled([notifyHub.stop(), closeQueue(), closeDatabase()]);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
