import { basename } from "node:path";
import { closeDatabase } from "@sourceweft/db";
import { logger } from "../shared/logger";
import { syncModelPricing } from "../shared/model-gateway/sync-pricing";

async function main() {
  try {
    await syncModelPricing();
    logger.info("sync-model-pricing script completed");
  } catch (error) {
    logger.error("sync-model-pricing script failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

const invokedScript = process.argv[1] ? basename(process.argv[1]) : "";

if (
  invokedScript === "sync-model-pricing.ts" ||
  invokedScript === "sync-model-pricing.js"
) {
  void main();
}
