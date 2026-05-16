import { closeDatabase } from "../shared/database";
import { logger } from "../shared/logger";
import { syncModelPricing } from "../shared/scripts/sync-model-pricing";

syncModelPricing()
  .then(() => {
    logger.info("sync-model-pricing script completed");
  })
  .catch((error) => {
    logger.error("sync-model-pricing script failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
