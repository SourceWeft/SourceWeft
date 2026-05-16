import { serve } from "@hono/node-server";
import { config } from "../shared/config";
import { closeDatabase } from "../shared/database";
import { logger } from "../shared/logger";
import {
  ensureModelConfigAvailable,
  syncGlobalModelGatewayConfig,
} from "../shared/model-gateway/index";
import { closeQueue } from "../shared/queue";
import { createApp } from "./app";
import { contentSkillsService } from "../modules/content/skills";

await syncGlobalModelGatewayConfig();
await ensureModelConfigAvailable();
await contentSkillsService.syncBuiltinCatalog();

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
