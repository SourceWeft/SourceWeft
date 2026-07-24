import { serve } from "@hono/node-server";
import { config } from "../shared/config";
import { closeDatabase } from "@sourceweft/db";
import { logger } from "../shared/logger";
import {
  ensureModelConfigAvailable,
  syncGlobalModelGatewayConfig,
} from "../shared/model-gateway/index";
import { closeQueue } from "../shared/queue";
import { notifyHub } from "../shared/notify-hub";
import { createApp } from "./app";
import { contentSkillsService } from "../modules/skills";
import { agentSandboxService } from "../modules/threads";
import { connectorAdaptersReady } from "../modules/connectors";

await syncGlobalModelGatewayConfig({ syncPricing: false });
await ensureModelConfigAvailable();
await contentSkillsService.syncBuiltinCatalog();
// Connectors are contributed by capabilities, so registering them reads
// manifests. Await it before serving so the registry is never consulted empty.
await connectorAdaptersReady();
// Live thread collaboration: start the LISTEN connection before serving so the
// first /room subscriber has a working fan-out. API process only — the worker
// and scheduler publish events but never hold SSE subscribers.
await notifyHub.start();

const app = createApp();

serve(
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

async function shutdown() {
  logger.info("API shutting down");
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
