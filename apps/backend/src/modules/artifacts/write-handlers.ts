import {
  collectArtifactWriteHandlers,
  createArtifactWriteHandlerRegistry as buildArtifactWriteHandlerRegistry,
  EMPTY_ARTIFACT_WRITE_HANDLER_REGISTRY,
  type ArtifactWriteHandlerRegistry,
  type ArtifactWriteHandlerWarning,
} from "@sourceweft/agent-tool-registry";
import type { ArtifactWriteHandler } from "@sourceweft/contracts";
import { logger } from "../../shared/logger";

/**
 * Host wiring for the write-side artifact handler registry — the mirror of
 * `./view-handlers.ts`.
 *
 * Collection and indexing live in the capability registry package; the backend
 * only supplies logging and memoizes the result.
 */

export type { ArtifactWriteHandlerRegistry };

function logWarning(warning: ArtifactWriteHandlerWarning) {
  if (warning.kind === "conflict") {
    logger.warn("artifact_write_handler_conflict", {
      artifactType: warning.artifactType,
    });
    return;
  }
  logger.warn("artifact_write_handler_load_failed", {
    packageName: warning.packageName,
    error:
      warning.error instanceof Error
        ? warning.error.message
        : String(warning.error),
  });
}

export function createArtifactWriteHandlerRegistry(
  handlers: readonly ArtifactWriteHandler[],
): ArtifactWriteHandlerRegistry {
  return buildArtifactWriteHandlerRegistry(handlers, { onWarn: logWarning });
}

let registryPromise: Promise<ArtifactWriteHandlerRegistry> | null = null;

/** Memoized across requests; the module set is fixed at build time. */
export function loadArtifactWriteHandlerRegistry(): Promise<ArtifactWriteHandlerRegistry> {
  registryPromise ??= collectArtifactWriteHandlers({ onWarn: logWarning })
    .then(createArtifactWriteHandlerRegistry)
    .catch((error) => {
      registryPromise = null;
      logger.error("artifact_write_handler_registry_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return EMPTY_ARTIFACT_WRITE_HANDLER_REGISTRY;
    });
  return registryPromise;
}
