import { serve } from "@hono/node-server";
import { config } from "../shared/config";
import { closeDatabase } from "@sourceweft/db";
import { logger } from "../shared/logger";
import {
  ensureModelConfigAvailable,
  syncGlobalModelGatewayConfig,
} from "../shared/model-gateway/index";
import { closeQueue } from "../shared/queue";
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
    agentSandboxService.logStartupWarning("api");
  },
);

async function shutdown() {
  logger.info("API shutting down");
  await Promise.allSettled([closeQueue(), closeDatabase()]);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
