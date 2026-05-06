import { serve } from "@hono/node-server";
import { config } from "../shared/config";
import { closeDatabase } from "../shared/database";
import { logger } from "../shared/logger";
import { ensureModelConfigAvailable } from "../shared/model-gateway/index";
import { closeQueue } from "../shared/queue";
import { createApp } from "./app";
import { contentSkillsService } from "../modules/content/skills";

await ensureModelConfigAvailable();
await contentSkillsService.syncBuiltinCatalog();

const app = createApp();

serve(
  {
    fetch: app.fetch,
    port: config.apiPort,
  },
  () => {
    logger.info("API server started", { port: config.apiPort });
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
