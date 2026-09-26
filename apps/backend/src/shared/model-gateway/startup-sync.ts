import { logger } from "../logger";
import {
  ModelCatalogUnavailableError,
  syncGlobalModelGatewayConfig,
} from "./config-sync";
import { findActiveConfigVersionRow } from "./runtime";

type SyncOptions = Parameters<typeof syncGlobalModelGatewayConfig>[0];

/** Backoff between background retries after a startup catalog failure. */
export const STARTUP_SYNC_RETRY_DELAYS_MS = [
  30_000, 60_000, 120_000, 300_000,
] as const;

type StartupSyncDependencies = {
  sync: (options?: SyncOptions) => Promise<void>;
  findActiveVersion: () => Promise<{ id: string } | null>;
  schedule: (run: () => void, delayMs: number) => void;
};

const defaultDependencies: StartupSyncDependencies = {
  sync: syncGlobalModelGatewayConfig,
  findActiveVersion: () => findActiveConfigVersionRow(),
  schedule: (run, delayMs) => {
    setTimeout(run, delayMs).unref?.();
  },
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sync the global model gateway configuration when a process starts.
 *
 * An invalid configuration fails startup, as does any failure on a deployment
 * that has never activated a configuration: there is nothing to serve from.
 * A model catalog source that cannot be reached is different. The sync stops
 * before activating anything, so the active version is retained; the process
 * keeps serving from it and retries the sync in the background with backoff
 * until one succeeds, instead of dying on a transient outside failure.
 */
export async function syncGlobalModelGatewayConfigAtStartup(
  options?: SyncOptions,
  dependencies: StartupSyncDependencies = defaultDependencies,
) {
  try {
    await dependencies.sync(options);
    return;
  } catch (error) {
    if (!(error instanceof ModelCatalogUnavailableError)) {
      throw error;
    }
    const activeVersion = await dependencies.findActiveVersion();
    if (!activeVersion) {
      throw error;
    }
    logger.error(
      "Model catalog unavailable at startup; serving the active model gateway configuration and retrying the sync",
      {
        activeConfigVersionId: activeVersion.id,
        retryInMs: STARTUP_SYNC_RETRY_DELAYS_MS[0],
        error: errorMessage(error),
      },
    );
  }

  const retry = (attempt: number) => {
    const delayMs =
      STARTUP_SYNC_RETRY_DELAYS_MS[
        Math.min(attempt, STARTUP_SYNC_RETRY_DELAYS_MS.length - 1)
      ]!;
    dependencies.schedule(() => {
      dependencies.sync(options).then(
        () => {
          logger.info("Model gateway configuration sync recovered", {
            attempts: attempt + 1,
          });
        },
        (error: unknown) => {
          if (error instanceof ModelCatalogUnavailableError) {
            logger.warn("Model gateway configuration sync retry failed", {
              attempt: attempt + 1,
              error: errorMessage(error),
            });
            retry(attempt + 1);
            return;
          }
          // Not an outside failure: retrying the same configuration will not
          // help. Keep serving the active version and surface it loudly.
          logger.error(
            "Model gateway configuration sync failed with a non-catalog error; not retrying",
            { attempt: attempt + 1, error: errorMessage(error) },
          );
        },
      );
    }, delayMs);
  };
  retry(0);
}
